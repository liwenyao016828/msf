import { type OrbParams } from "./presets";
import { writeOrbUniforms } from "./orb-uniforms";
import { orbShaderSource } from "./shader-source";
import { SlowRenderGuard } from "../../render-guard";

export type OrbRendererOptions = {
  canvas: HTMLCanvasElement;
  getParams: () => OrbParams;
  isPaused?: () => boolean;
  onError: (error: Error) => void;
  onReady: () => void;
  /** Abort a hung WebGPU adapter/device request and fall back to WebGL2. */
  initTimeoutMs?: number;
  /** Upper bound for rendered frames per second (0 disables the cap). */
  targetFps?: number;
  /** The measured render cost on this device is unusable: stop and degrade. */
  onTooSlow?: (detail: string) => void;
  /**
   * No usable WebGPU adapter (request resolved null): the owner should show
   * the static poster instead of retrying the heavy shader through WebGL2.
   */
  onUnavailable?: (detail: string) => void;
};

export function createOrbRenderer({
  canvas,
  getParams,
  isPaused = () => false,
  onError,
  onReady,
  initTimeoutMs = 2000,
  targetFps = 30,
  onTooSlow,
  onUnavailable,
}: OrbRendererOptions): () => void {
  let disposed = false;
  let animationFrame = 0;
  let device: GPUDevice | null = null;
  let readyNotified = false;
  let failed = false;

  function fail(error: Error): void {
    if (disposed || failed) return;
    failed = true;
    cancelAnimationFrame(animationFrame);
    device?.destroy();
    onError(error);
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function start(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error("当前浏览器不支持 WebGPU");
    }

    const adapter = await withTimeout(navigator.gpu.requestAdapter(), initTimeoutMs, "WebGPU 适配器请求");
    if (!adapter) {
      // A resolved-null adapter (VM / remote desktop / unsupported driver /
      // battery saver) means the heavy shader would very likely fall back to
      // the software rasterizer — hand control back instead of trying WebGL2.
      if (onUnavailable) {
        onUnavailable("webgpu-adapter-null");
        return;
      }
      throw new Error("未找到可用的 WebGPU 适配器");
    }

    device = await withTimeout(adapter.requestDevice(), initTimeoutMs, "WebGPU 设备创建");
    if (disposed) {
      device.destroy();
      return;
    }

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("无法创建 WebGPU 画布上下文");
    }
    const gpuContext: GPUCanvasContext = context;

    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuContext.configure({ device, format, alphaMode: "premultiplied" });

    const shader = device.createShaderModule({
      label: "orb-glass-liquid",
      code: orbShaderSource,
    });
    const compilation = await shader.getCompilationInfo();
    const compilationErrors = compilation.messages.filter(
      (message) => message.type === "error",
    );
    if (compilationErrors.length > 0) {
      throw new Error(
        compilationErrors
          .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
          .join("\n"),
      );
    }

    const pipeline = device.createRenderPipeline({
      label: "orb-glass-liquid-pipeline",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    const values = new Float32Array(128);
    const uniformBuffer = device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const startedAt = performance.now();
    const frameInterval = targetFps > 0 ? 1000 / targetFps : 0;
    let lastFrameAt = 0;
    const guard = onTooSlow ? new SlowRenderGuard(frameInterval || 33) : null;

    device.lost.then((info) => {
      fail(new Error(`WebGPU 设备已断开：${info.message || info.reason}`));
    });
    device.addEventListener("uncapturederror", (event) => {
      event.preventDefault();
      fail(new Error(`WebGPU 渲染错误：${event.error.message}`));
    });

    function resize(): void {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function frame(now: number): void {
      if (disposed || failed || !device) {
        return;
      }

      try {
        if (isPaused()) {
          animationFrame = requestAnimationFrame(frame);
          return;
        }
        // Cap the render rate: on a 60Hz panel every other frame is skipped, so
        // the heavy shader costs half the CPU/GPU time. The rAF chain keeps
        // running so the orb resumes immediately when the page becomes visible.
        if (frameInterval > 0 && now - lastFrameAt < frameInterval) {
          animationFrame = requestAnimationFrame(frame);
          return;
        }
        lastFrameAt = now;
        const frameStartedAt = performance.now();
        resize();
        writeOrbUniforms(
          values,
          canvas.width,
          canvas.height,
          (now - startedAt) / 1000,
          getParams(),
        );
        device.queue.writeBuffer(uniformBuffer, 0, values);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: gpuContext.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
        device.queue.submit([encoder.finish()]);
        if (guard && onTooSlow) {
          const verdict = guard.observe(performance.now() - frameStartedAt, now);
          if (verdict.degrade) {
            disposed = true;
            cancelAnimationFrame(animationFrame);
            onTooSlow("WebGPU 帧耗时过高");
            return;
          }
        }
        if (!readyNotified) {
          readyNotified = true;
          onReady();
        }
        animationFrame = requestAnimationFrame(frame);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    animationFrame = requestAnimationFrame(frame);
  }

  start().catch((error: unknown) => {
    fail(error instanceof Error ? error : new Error(String(error)));
  });

  return () => {
    disposed = true;
    cancelAnimationFrame(animationFrame);
    device?.destroy();
  };
}
