import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import UpdateManager from './src/UpdateManager';

type UpdateState = {
  checking: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
};

export default function App() {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    downloading: false,
    progress: 0,
    error: null,
  });

  useEffect(() => {
    UpdateManager.initStartupGuard();

    UpdateManager.update({
      onCheckStart: () => setState((s) => ({ ...s, checking: true })),
      onCheckComplete: () => setState((s) => ({ ...s, checking: false })),
      onDownloadStart: () => setState((s) => ({ ...s, downloading: true })),
      onDownloadProgress: (p) => setState((s) => ({ ...s, progress: p })),
      onDownloadComplete: () => setState((s) => ({ ...s, downloading: false })),
      onError: (e) => setState((s) => ({ ...s, error: e.message })),
    });

    const timer = setTimeout(() => {
      UpdateManager.notifyAppReady();
    }, 5000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <Text style={styles.title}>RN Hot Update Demo</Text>
      <Text style={styles.item}>检查更新中: {state.checking ? '是' : '否'}</Text>
      <Text style={styles.item}>下载中: {state.downloading ? '是' : '否'}</Text>
      <Text style={styles.item}>进度: {(state.progress * 100).toFixed(0)}%</Text>
      {state.error ? <Text style={styles.error}>错误: {state.error}</Text> : null}
      <Text style={styles.tip}>后台服务: http://localhost:3000</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  item: {
    fontSize: 14,
    marginBottom: 6,
  },
  error: {
    marginTop: 8,
    color: '#d11a2a',
  },
  tip: {
    marginTop: 16,
    color: '#666',
  },
});
