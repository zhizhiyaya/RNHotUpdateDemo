package com.rnhotupdatedemo;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.text.TextUtils;

import com.facebook.react.ReactApplication;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class RNUpdateManagerModule extends ReactContextBaseJavaModule {
  private static final String PREFS = "RNUpdateManager";
  private static final String KEY_PENDING_PATH = "pendingPath";
  private static final String KEY_PENDING_LABEL = "pendingLabel";
  private static final String KEY_PENDING_ATTEMPT = "pendingAttemptAt";
  private static final String KEY_PENDING_FAIL = "pendingFailCount";
  private static final String KEY_ACTIVE_LABEL = "activeLabel";

  private final ReactApplicationContext reactContext;

  public RNUpdateManagerModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return "RNUpdateManager";
  }

  private SharedPreferences prefs() {
    return reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static File bundlesRoot(Context context) {
    return new File(context.getFilesDir(), "bundles");
  }

  private static File bundleDir(Context context, String label) {
    return new File(bundlesRoot(context), label);
  }

  private static File bundlePath(Context context, String label) {
    return new File(bundleDir(context, label), "index.bundle");
  }

  @ReactMethod
  public void getBundleDirectory(String label, Promise promise) {
    File dir = bundleDir(reactContext, label);
    if (!dir.exists()) dir.mkdirs();
    promise.resolve(dir.getAbsolutePath());
  }

  @ReactMethod
  public void getCurrentBundlePath(Promise promise) {
    String path = getActiveBundlePath(reactContext);
    if (path == null) {
      path = ensureBaseBundle(reactContext);
    }
    promise.resolve(path);
  }

  @ReactMethod
  public void setPendingUpdate(String label, String bundlePath, Promise promise) {
    prefs().edit()
      .putString(KEY_PENDING_PATH, bundlePath)
      .putString(KEY_PENDING_LABEL, label)
      .putLong(KEY_PENDING_ATTEMPT, 0)
      .putInt(KEY_PENDING_FAIL, 0)
      .apply();
    promise.resolve(true);
  }

  @ReactMethod
  public void markUpdateVerified(String label, Promise promise) {
    prefs().edit()
      .putString(KEY_ACTIVE_LABEL, label)
      .remove(KEY_PENDING_PATH)
      .remove(KEY_PENDING_LABEL)
      .remove(KEY_PENDING_ATTEMPT)
      .remove(KEY_PENDING_FAIL)
      .apply();
    promise.resolve(true);
  }

  @ReactMethod
  public void downloadBundle(String url, String label, Promise promise) {
    new Thread(() -> {
      try {
        URL downloadUrl = new URL(url);
        HttpURLConnection conn = (HttpURLConnection) downloadUrl.openConnection();
        conn.setRequestMethod("GET");
        conn.connect();

        File dir = bundleDir(reactContext, label);
        if (!dir.exists()) dir.mkdirs();

        File bundleFile = new File(dir, "index.bundle");
        if (bundleFile.exists()) bundleFile.delete();

        InputStream is = conn.getInputStream();
        FileOutputStream fos = new FileOutputStream(bundleFile);

        byte[] buffer = new byte[8192];
        int bytesRead;
        long totalBytes = 0;
        long fileSize = conn.getContentLength();

        while ((bytesRead = is.read(buffer)) != -1) {
          fos.write(buffer, 0, bytesRead);
          totalBytes += bytesRead;

          if (fileSize > 0) {
            double progress = (double) totalBytes / (double) fileSize;
            sendEvent("downloadProgress", progress);
          }
        }

        fos.close();
        is.close();

        promise.resolve(bundleFile.getAbsolutePath());
      } catch (Exception e) {
        promise.reject("download_error", e.getMessage());
      }
    }).start();
  }

  @ReactMethod
  public void reloadBundle(String bundlePath, Promise promise) {
    reactContext.runOnUiQueueThread(() -> {
      try {
        ReactInstanceManager manager = ((ReactApplication) reactContext.getApplicationContext())
          .getReactNativeHost()
          .getReactInstanceManager();
        manager.recreateReactContextInBackground();
        promise.resolve(true);
      } catch (Exception e) {
        promise.reject("reload_error", e.getMessage());
      }
    });
  }

  private void sendEvent(String eventName, Object params) {
    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
      .emit(eventName, params);
  }

  public static String getBundlePath(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String pendingPath = prefs.getString(KEY_PENDING_PATH, null);
    if (!TextUtils.isEmpty(pendingPath) && new File(pendingPath).exists()) {
      long lastAttempt = prefs.getLong(KEY_PENDING_ATTEMPT, 0);
      int failCount = prefs.getInt(KEY_PENDING_FAIL, 0);

      if (lastAttempt > 0) {
        failCount += 1;
        prefs.edit().putInt(KEY_PENDING_FAIL, failCount).apply();
      }

      if (failCount >= 1) {
        clearPending(prefs);
      } else {
        prefs.edit().putLong(KEY_PENDING_ATTEMPT, System.currentTimeMillis()).apply();
        return pendingPath;
      }
    }

    String active = getActiveBundlePath(context);
    if (active != null) return active;

    return ensureBaseBundle(context);
  }

  private static String getActiveBundlePath(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String label = prefs.getString(KEY_ACTIVE_LABEL, null);
    if (TextUtils.isEmpty(label)) return null;
    File file = bundlePath(context, label);
    return file.exists() ? file.getAbsolutePath() : null;
  }

  private static String ensureBaseBundle(Context context) {
    File baseDir = bundleDir(context, "base");
    if (!baseDir.exists()) baseDir.mkdirs();
    File baseFile = new File(baseDir, "index.bundle");
    if (baseFile.exists()) return baseFile.getAbsolutePath();

    try {
      AssetManager am = context.getAssets();
      InputStream is = am.open("index.android.bundle");
      FileOutputStream fos = new FileOutputStream(baseFile);
      byte[] buffer = new byte[8192];
      int bytesRead;
      while ((bytesRead = is.read(buffer)) != -1) {
        fos.write(buffer, 0, bytesRead);
      }
      fos.close();
      is.close();
    } catch (Exception e) {
      return "assets://index.android.bundle";
    }

    return baseFile.getAbsolutePath();
  }

  private static void clearPending(SharedPreferences prefs) {
    prefs.edit()
      .remove(KEY_PENDING_PATH)
      .remove(KEY_PENDING_LABEL)
      .remove(KEY_PENDING_ATTEMPT)
      .remove(KEY_PENDING_FAIL)
      .apply();
  }
}
