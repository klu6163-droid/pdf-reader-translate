import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  downloadFrontendCrash,
  formatFrontendCrash,
  recordFrontendCrash,
} from '@/services/diagnostics';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  logPath: string;
  report: string;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, logPath: '', report: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = formatFrontendCrash(error, info);
    this.setState({ report });
    void recordFrontendCrash(error, info)
      .then((logPath) => this.setState({ logPath }))
      .catch(() => {
        // The fallback screen still offers a direct crash-report download.
      });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="h-full flex items-center justify-center bg-slate-100 p-6">
        <section className="max-w-xl w-full rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-red-700">界面发生异常</h1>
          <p className="mt-2 text-sm text-slate-600">
            崩溃信息已保存。你可以重新加载应用；反馈问题时请附上崩溃日志或诊断包。
          </p>
          <p className="mt-3 rounded bg-slate-50 p-2 text-xs text-slate-700 break-all">
            {this.state.logPath || '浏览器模式：请下载下方崩溃信息'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-700"
            >
              重新加载
            </button>
            <button
              onClick={() => downloadFrontendCrash(this.state.report)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              下载崩溃信息
            </button>
          </div>
        </section>
      </main>
    );
  }
}
