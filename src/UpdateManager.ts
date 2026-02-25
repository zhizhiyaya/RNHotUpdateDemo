import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import CryptoJS from 'crypto-js';

const { RNUpdateManager } = NativeModules;
const updateEmitter = new NativeEventEmitter(RNUpdateManager);

const ACTIVE_KEY = 'activeLabel';
const PENDING_KEY = 'pendingUpdate';
const STARTUP_CONFIRM_MS = 10_000;

export interface UpdateInfo {
  isAvailable: boolean;
  releaseId?: string;
  label: string;
  appVersion: string;
  description: string;
  downloadUrl: string;
  isMandatory: boolean;
  packageHash: string; // SHA256
  packageSize: number;
  minAppVersion?: string;
  maxAppVersion?: string;
  isDiffPackage?: boolean;
  diffAgainstLabel?: string;
  patchUrl?: string;
  patchSize?: number;
  patchHash?: string;
  patchAlgorithm?: string;
  patchChunkSize?: number;
  assetsManifestUrl?: string;
  assetsHash?: string;
  assetsSize?: number;
}

export interface UpdateOptions {
  onCheckStart?: () => void;
  onCheckComplete?: (hasUpdate: boolean) => void;
  onDownloadStart?: () => void;
  onDownloadProgress?: (progress: number) => void;
  onDownloadComplete?: () => void;
  onInstallStart?: () => void;
  onInstallComplete?: () => void;
  onError?: (error: Error) => void;
}

class UpdateManager {
  baseUrl = 'http://localhost:3000/api';
  deploymentKey = 'DEMO-DEPLOYMENT-KEY';

  async initStartupGuard(): Promise<void> {
    const pending = await this.getPending();
    if (!pending) return;

    const age = Date.now() - pending.appliedAt;
    if (age > STARTUP_CONFIRM_MS * 2) {
      pending.failCount = (pending.failCount || 0) + 1;
      if (pending.failCount >= 1) {
        await this.clearPending();
        return;
      }
      await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    }
  }

  async notifyAppReady(): Promise<void> {
    const pending = await this.getPending();
    if (!pending) return;

    await this.setCurrentLabel(pending.label);
    await this.clearPending();

    if (RNUpdateManager?.markUpdateVerified) {
      await RNUpdateManager.markUpdateVerified(pending.label);
    }

    await this.reportInstallComplete(pending);
  }

  async checkForUpdate(): Promise<UpdateInfo | null> {
    const appVersion = DeviceInfo.getVersion();
    const platform = Platform.OS;
    const deviceId = await DeviceInfo.getUniqueId();
    const currentLabel = await this.getCurrentLabel();

    const response = await fetch(`${this.baseUrl}/update/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deploymentKey: this.deploymentKey,
        deviceId,
        clientUniqueId: deviceId,
        platform,
        appVersion,
        currentLabel
      })
    });

    const data = await response.json();
    const updateInfo: UpdateInfo | undefined = data.updateInfo;
    if (updateInfo?.isAvailable) return updateInfo;
    return null;
  }

  async update(options?: UpdateOptions): Promise<void> {
    let updateInfo: UpdateInfo | null = null;
    try {
      options?.onCheckStart?.();
      updateInfo = await this.checkForUpdate();
      options?.onCheckComplete?.(!!updateInfo);
      if (!updateInfo) return;

      options?.onDownloadStart?.();
      await this.reportDownloadStart(updateInfo);

      const bundlePath = await this.downloadUpdate(updateInfo, options?.onDownloadProgress);
      options?.onDownloadComplete?.();

      if (updateInfo.assetsManifestUrl) {
        await this.syncAssets(updateInfo.assetsManifestUrl, updateInfo.label, updateInfo.assetsHash);
      }

      options?.onInstallStart?.();
      const fromLabel = await this.getCurrentLabel();
      await this.applyUpdateAtomically(bundlePath, updateInfo, fromLabel);
      options?.onInstallComplete?.();
    } catch (error) {
      const err = error as Error;
      options?.onError?.(err);
      await this.reportError(err, updateInfo || undefined);
      throw err;
    }
  }

  private async downloadUpdate(updateInfo: UpdateInfo, onProgress?: (p: number) => void): Promise<string> {
    const shouldUsePatch = updateInfo.patchUrl
      && updateInfo.diffAgainstLabel
      && (
        !updateInfo.patchSize
        || !updateInfo.packageSize
        || updateInfo.patchSize < updateInfo.packageSize * 0.7
      );

    if (shouldUsePatch) {
      try {
        const patchPath = await this.downloadPatch(updateInfo.patchUrl, updateInfo.label, onProgress);
        const oldBundlePath = await RNUpdateManager.getCurrentBundlePath();
        if (!oldBundlePath) throw new Error('Base bundle not found');
        const bundleDir = await RNUpdateManager.getBundleDirectory(updateInfo.label);
        await RNFS.mkdir(bundleDir);
        const newBundlePath = `${bundleDir}/index.bundle`;

        await this.applyChunkPatch(patchPath, oldBundlePath, newBundlePath);
        const ok = await this.verifyBundle(newBundlePath, updateInfo.packageHash);
        if (!ok) throw new Error('Patch bundle hash mismatch');

        return newBundlePath;
      } catch (error) {
        return this.downloadFullBundle(updateInfo, onProgress);
      }
    }

    return this.downloadFullBundle(updateInfo, onProgress);
  }

  private async downloadFullBundle(updateInfo: UpdateInfo, onProgress?: (p: number) => void): Promise<string> {
    const progressListener = updateEmitter.addListener('downloadProgress', (progress: number) => {
      onProgress?.(progress);
    });

    try {
      const bundlePath: string = await RNUpdateManager.downloadBundle(
        updateInfo.downloadUrl,
        updateInfo.label
      );
      const ok = await this.verifyBundle(bundlePath, updateInfo.packageHash);
      if (!ok) throw new Error('Bundle hash mismatch');
      return bundlePath;
    } finally {
      progressListener.remove();
    }
  }

  private async downloadPatch(url: string, label: string, onProgress?: (p: number) => void): Promise<string> {
    const patchDir = `${RNFS.DocumentDirectoryPath}/patches`;
    await RNFS.mkdir(patchDir);
    const patchPath = `${patchDir}/${label}.patch.json`;

    await RNFS.downloadFile({
      fromUrl: url,
      toFile: patchPath,
      progress: (p) => {
        if (p.contentLength) {
          onProgress?.(p.bytesWritten / p.contentLength);
        }
      },
      progressDivider: 5
    }).promise;

    return patchPath;
  }

  private async applyChunkPatch(patchPath: string, oldBundlePath: string, newBundlePath: string): Promise<void> {
    const patchRaw = await RNFS.readFile(patchPath, 'utf8');
    const patch = JSON.parse(patchRaw);
    if (patch.algorithm !== 'chunk-v1') {
      throw new Error(`Unsupported patch algorithm: ${patch.algorithm}`);
    }

    if (patch.baseHash) {
      const baseHash = await this.calculateSHA256(oldBundlePath);
      if (baseHash !== patch.baseHash) {
        throw new Error('Patch base hash mismatch');
      }
    }

    const baseText = await RNFS.readFile(oldBundlePath, 'utf8');
    const parts: string[] = [];
    for (const op of patch.ops || []) {
      if (!op || !op.length) continue;
      if (op[0] === 'c') {
        const offset = op[1];
        const length = op[2];
        parts.push(baseText.slice(offset, offset + length));
      } else if (op[0] === 'd') {
        parts.push(op[1] || '');
      }
    }

    const newText = parts.join('');
    await RNFS.writeFile(newBundlePath, newText, 'utf8');
  }

  private async verifyBundle(bundlePath: string, expectedHash: string): Promise<boolean> {
    const hash = await this.calculateSHA256(bundlePath);
    return hash === expectedHash;
  }

  private async calculateSHA256(filePath: string): Promise<string> {
    const base64 = await RNFS.readFile(filePath, 'base64');
    const wordArray = CryptoJS.enc.Base64.parse(base64);
    return CryptoJS.SHA256(wordArray).toString();
  }

  private async hashFile(filePath: string): Promise<string> {
    const base64 = await RNFS.readFile(filePath, 'base64');
    const wordArray = CryptoJS.enc.Base64.parse(base64);
    return CryptoJS.SHA256(wordArray).toString();
  }

  private async syncAssets(manifestUrl: string, label: string, expectedHash?: string): Promise<void> {
    const manifestRaw = await fetch(manifestUrl).then(r => r.text());
    if (expectedHash) {
      const hash = CryptoJS.SHA256(manifestRaw).toString();
      if (hash !== expectedHash) throw new Error('Assets manifest hash mismatch');
    }
    const manifest = JSON.parse(manifestRaw);

    const baseDir = `${RNFS.DocumentDirectoryPath}/assets/${label}`;
    for (const file of manifest.files || []) {
      const localPath = `${baseDir}/${file.path}`;
      const exists = await RNFS.exists(localPath);
      if (!exists || (await this.hashFile(localPath)) !== file.hash) {
        await RNFS.mkdir(pathDir(localPath));
        await RNFS.downloadFile({
          fromUrl: file.url || `${manifest.baseUrl}/${file.path}`,
          toFile: localPath
        }).promise;
        const ok = (await this.hashFile(localPath)) === file.hash;
        if (!ok) throw new Error('Asset hash mismatch');
      }
    }
  }

  private async applyUpdateAtomically(
    bundlePath: string,
    updateInfo: UpdateInfo,
    fromLabel: string | null
  ): Promise<void> {
    if (RNUpdateManager?.setPendingUpdate) {
      await RNUpdateManager.setPendingUpdate(updateInfo.label, bundlePath);
    }

    await this.setPending({
      label: updateInfo.label,
      bundlePath,
      releaseId: updateInfo.releaseId,
      fromLabel
    });

    await RNUpdateManager.reloadBundle(bundlePath);
  }

  private async reportDownloadStart(updateInfo: UpdateInfo): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/update/download-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: await DeviceInfo.getUniqueId(),
          releaseId: updateInfo.releaseId,
          label: updateInfo.label
        })
      });
    } catch (_) {}
  }

  private async reportInstallComplete(pending: any): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/update/install-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: await DeviceInfo.getUniqueId(),
          releaseId: pending.releaseId,
          label: pending.label,
          fromLabel: pending.fromLabel,
          installTime: Math.round(STARTUP_CONFIRM_MS / 1000)
        })
      });
    } catch (_) {}
  }

  private async reportError(error: Error, updateInfo?: UpdateInfo): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/update/report-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: await DeviceInfo.getUniqueId(),
          releaseId: updateInfo?.releaseId,
          label: updateInfo?.label,
          errorMessage: error.message,
          errorStack: error.stack,
          stage: 'install'
        })
      });
    } catch (_) {}
  }

  private async getCurrentLabel(): Promise<string | null> {
    return AsyncStorage.getItem(ACTIVE_KEY);
  }

  private async setCurrentLabel(label: string): Promise<void> {
    await AsyncStorage.setItem(ACTIVE_KEY, label);
  }

  private async setPending(params: {
    label: string;
    bundlePath: string;
    releaseId?: string;
    fromLabel?: string | null;
  }): Promise<void> {
    const { label, bundlePath, releaseId, fromLabel } = params;
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({
      label,
      bundlePath,
      releaseId,
      fromLabel,
      appliedAt: Date.now(),
      verified: false,
      failCount: 0
    }));
  }

  private async getPending(): Promise<any | null> {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  private async clearPending(): Promise<void> {
    await AsyncStorage.removeItem(PENDING_KEY);
  }
}

function pathDir(p: string): string {
  return p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
}

export default new UpdateManager();
