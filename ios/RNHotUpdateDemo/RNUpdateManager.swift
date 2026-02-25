import Foundation
import React

@objc(RNUpdateManager)
class RNUpdateManager: RCTEventEmitter, URLSessionDownloadDelegate {
  private let kPendingPathKey = "RNUpdatePendingPath"
  private let kPendingLabelKey = "RNUpdatePendingLabel"
  private let kPendingAttemptKey = "RNUpdatePendingAttemptAt"
  private let kPendingFailCountKey = "RNUpdatePendingFailCount"
  private let kActiveLabelKey = "RNUpdateActiveLabel"

  private var session: URLSession!
  private var resolveMap: [Int: RCTPromiseResolveBlock] = [:]
  private var rejectMap: [Int: RCTPromiseRejectBlock] = [:]
  private var labelMap: [Int: String] = [:]

  override init() {
    super.init()
    let config = URLSessionConfiguration.default
    session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return ["downloadProgress"]
  }

  // MARK: - Paths

  private static func bundlesRootDir() -> String {
    let docPath = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
    return (docPath as NSString).appendingPathComponent("bundles")
  }

  private static func bundleDirectory(label: String) -> String {
    return (bundlesRootDir() as NSString).appendingPathComponent(label)
  }

  private static func bundlePath(label: String) -> String {
    return (bundleDirectory(label: label) as NSString).appendingPathComponent("index.bundle")
  }

  private static func mainBundlePath() -> String? {
    return Bundle.main.path(forResource: "main", ofType: "jsbundle")
  }

  @objc static func getActiveBundlePath() -> String? {
    let defaults = UserDefaults.standard
    if let activeLabel = defaults.string(forKey: "RNUpdateActiveLabel"), !activeLabel.isEmpty {
      let path = bundlePath(label: activeLabel)
      if FileManager.default.fileExists(atPath: path) {
        return path
      }
    }
    return mainBundlePath()
  }

  private static func clearPending() {
    let defaults = UserDefaults.standard
    defaults.removeObject(forKey: "RNUpdatePendingPath")
    defaults.removeObject(forKey: "RNUpdatePendingLabel")
    defaults.removeObject(forKey: "RNUpdatePendingAttemptAt")
    defaults.removeObject(forKey: "RNUpdatePendingFailCount")
    defaults.synchronize()
  }

  @objc static func bundleURL() -> URL? {
    let defaults = UserDefaults.standard
    if let pendingPath = defaults.string(forKey: "RNUpdatePendingPath"),
       FileManager.default.fileExists(atPath: pendingPath) {

      let lastAttempt = defaults.double(forKey: "RNUpdatePendingAttemptAt")
      var failCount = defaults.integer(forKey: "RNUpdatePendingFailCount")

      if lastAttempt > 0 {
        failCount += 1
        defaults.set(failCount, forKey: "RNUpdatePendingFailCount")
      }

      if failCount >= 1 {
        clearPending()
      } else {
        defaults.set(Date().timeIntervalSince1970, forKey: "RNUpdatePendingAttemptAt")
        defaults.synchronize()
        return URL(fileURLWithPath: pendingPath)
      }
    }

    if let activePath = getActiveBundlePath() {
      return URL(fileURLWithPath: activePath)
    }

    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
  }

  // MARK: - Exposed Methods

  @objc(getBundleDirectory:resolver:rejecter:)
  func getBundleDirectory(_ label: String,
                          resolver resolve: RCTPromiseResolveBlock,
                          rejecter reject: RCTPromiseRejectBlock) {
    let dir = RNUpdateManager.bundleDirectory(label: label)
    do {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
      resolve(dir)
    } catch {
      reject("mkdir_failed", error.localizedDescription, error)
    }
  }

  @objc(getCurrentBundlePath:rejecter:)
  func getCurrentBundlePath(_ resolve: RCTPromiseResolveBlock,
                            rejecter reject: RCTPromiseRejectBlock) {
    resolve(RNUpdateManager.getActiveBundlePath())
  }

  @objc(setPendingUpdate:bundlePath:resolver:rejecter:)
  func setPendingUpdate(_ label: String,
                        bundlePath: String,
                        resolver resolve: RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
    let defaults = UserDefaults.standard
    defaults.set(bundlePath, forKey: kPendingPathKey)
    defaults.set(label, forKey: kPendingLabelKey)
    defaults.set(0.0, forKey: kPendingAttemptKey)
    defaults.set(0, forKey: kPendingFailCountKey)
    defaults.synchronize()
    resolve(true)
  }

  @objc(markUpdateVerified:resolver:rejecter:)
  func markUpdateVerified(_ label: String,
                          resolver resolve: RCTPromiseResolveBlock,
                          rejecter reject: RCTPromiseRejectBlock) {
    let defaults = UserDefaults.standard
    defaults.set(label, forKey: kActiveLabelKey)
    RNUpdateManager.clearPending()
    defaults.synchronize()
    resolve(true)
  }

  @objc(downloadBundle:label:resolver:rejecter:)
  func downloadBundle(_ url: String,
                      label: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let downloadURL = URL(string: url) else {
      reject("invalid_url", "Invalid download URL", nil)
      return
    }

    let task = session.downloadTask(with: downloadURL)
    let taskId = task.taskIdentifier
    resolveMap[taskId] = resolve
    rejectMap[taskId] = reject
    labelMap[taskId] = label
    task.resume()
  }

  @objc(reloadBundle:resolver:rejecter:)
  func reloadBundle(_ bundlePath: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let bridge = self.bridge else {
        reject("bridge_nil", "Bridge not ready", nil)
        return
      }
      let bundleURL = URL(fileURLWithPath: bundlePath)
      bridge.setValue(bundleURL, forKey: "bundleURL")
      bridge.reload()
      resolve(true)
    }
  }

  // MARK: - URLSessionDownloadDelegate

  func urlSession(_ session: URLSession,
                  downloadTask: URLSessionDownloadTask,
                  didWriteData bytesWritten: Int64,
                  totalBytesWritten: Int64,
                  totalBytesExpectedToWrite: Int64) {
    if totalBytesExpectedToWrite <= 0 { return }
    let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
    sendEvent(withName: "downloadProgress", body: progress)
  }

  func urlSession(_ session: URLSession,
                  downloadTask: URLSessionDownloadTask,
                  didFinishDownloadingTo location: URL) {
    let taskId = downloadTask.taskIdentifier
    let label = labelMap[taskId] ?? "unknown"

    let dir = RNUpdateManager.bundleDirectory(label: label)
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)

    let dest = (dir as NSString).appendingPathComponent("index.bundle")
    try? FileManager.default.removeItem(atPath: dest)

    do {
      try FileManager.default.moveItem(atPath: location.path, toPath: dest)
      resolveMap[taskId]?(dest)
    } catch {
      rejectMap[taskId]?("download_error", error.localizedDescription, error)
    }

    resolveMap.removeValue(forKey: taskId)
    rejectMap.removeValue(forKey: taskId)
    labelMap.removeValue(forKey: taskId)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error = error {
      let taskId = task.taskIdentifier
      rejectMap[taskId]?("download_error", error.localizedDescription, error)
      resolveMap.removeValue(forKey: taskId)
      rejectMap.removeValue(forKey: taskId)
      labelMap.removeValue(forKey: taskId)
    }
  }
}
