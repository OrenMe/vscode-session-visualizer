interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    // @ts-expect-error acquireVsCodeApi is injected by VS Code webview runtime
    api = acquireVsCodeApi();
  }
  return api!;
}
