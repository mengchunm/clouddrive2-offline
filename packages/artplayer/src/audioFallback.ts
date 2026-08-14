interface AudioOpenResult {
	requestId: string;
	supported?: boolean;
	codec?: string | null;
	channels?: number;
	sampleRate?: number;
	error?: string;
}

interface AudioDecodeResult {
	requestId: string;
	startTime?: number;
	duration?: number;
	sampleRate?: number;
	left?: ArrayBuffer;
	right?: ArrayBuffer;
	error?: string;
}

interface BufferedAudioChunk {
	result: AudioDecodeResult;
	startTime: number;
	generation: number;
}

export interface BrowserAudioFallbackOptions {
	video: HTMLVideoElement;
	videoUrl: string;
	audioSourceUrl?: string;
	notice?: (message: string) => void;
	preparation?: BrowserAudioPreparation;
}

const SEGMENT_DURATION = 10;
const REFILL_THRESHOLD = 5;
const MAX_DRIFT = 0.35;
const INITIAL_SCHEDULE_DELAY = 0.025;
const APPEND_SCHEDULE_DELAY = 0.005;

let requestSequence = 0;

interface PreparedDecodeCompletion {
	error?: unknown;
}

export interface BrowserAudioPreparation {
	startTime: number;
	sourceUrl: string;
	openResult: Promise<AudioOpenResult>;
	decodeCompletion: Promise<PreparedDecodeCompletion>;
	subscribe(listener: (chunk: AudioDecodeResult) => void): () => void;
}

function request<T extends { requestId: string; error?: string }>(
	type: "open" | "decode",
	detail: Record<string, unknown>,
	timeoutMs: number,
	onChunk?: (chunk: AudioDecodeResult) => void,
): Promise<T> {
	const requestId = `audio_${Date.now()}_${++requestSequence}`;
	return new Promise<T>((resolve, reject) => {
		const resultEvent = `cd2-audio-fallback-${type}-resolved`;
		const timeoutId = window.setTimeout(() => {
			window.removeEventListener(resultEvent, listener);
			window.removeEventListener(chunkEvent, chunkListener);
			reject(new Error(type === "open" ? "读取音轨超时" : "音频解码超时"));
		}, timeoutMs);
		const chunkEvent = "cd2-audio-fallback-decode-chunk";
		const chunkListener = (event: Event) => {
			const result = (event as CustomEvent<AudioDecodeResult>).detail;
			if (result?.requestId === requestId) onChunk?.(result);
		};
		const listener = (event: Event) => {
			const result = (event as CustomEvent<T>).detail;
			if (result?.requestId !== requestId) return;
			window.clearTimeout(timeoutId);
			window.removeEventListener(resultEvent, listener);
			window.removeEventListener(chunkEvent, chunkListener);
			if (result.error) reject(new Error(result.error));
			else resolve(result);
		};
		window.addEventListener(resultEvent, listener);
		if (type === "decode" && onChunk)
			window.addEventListener(chunkEvent, chunkListener);
		window.dispatchEvent(
			new CustomEvent(`cd2-audio-fallback-${type}`, {
				detail: { ...detail, requestId },
			}),
		);
	});
}

/**
 * Starts container probing and first-segment decoding before ArtPlayer exists.
 * Video loading remains independent and is never gated by this preparation.
 */
export function prepareBrowserAudioFallback(
	videoUrl: string,
	startTime: number,
	fileSize?: number,
	audioSourceUrl = videoUrl,
): BrowserAudioPreparation {
	const preparationStartedAt = performance.now();
	const chunks: AudioDecodeResult[] = [];
	const listeners = new Set<(chunk: AudioDecodeResult) => void>();
	let firstChunkLogged = false;
	const normalizedStartTime = Math.max(0, startTime);
	const openResult = request<AudioOpenResult>(
		"open",
		{ videoUrl: audioSourceUrl, fileSize },
		100000,
	);
	void openResult
		.then((result) => {
			console.info(
				`[cd2-artplayer] 音轨探测完成(${result.codec ?? "unknown"}): ${Math.round(performance.now() - preparationStartedAt)}ms`,
			);
		})
		.catch(() => undefined);
	const decodeCompletion = openResult
		.then(async (result): Promise<PreparedDecodeCompletion> => {
			if (!result.supported) return {};
			await request<AudioDecodeResult>(
				"decode",
				{ startTime: normalizedStartTime, duration: SEGMENT_DURATION },
				120000,
				(chunk) => {
					if (!firstChunkLogged) {
						firstChunkLogged = true;
						console.info(
							`[cd2-artplayer] 首个兼容音频 PCM 就绪: ${Math.round(performance.now() - preparationStartedAt)}ms`,
						);
					}
					chunks.push(chunk);
					for (const listener of listeners) listener(chunk);
				},
			);
			return {};
		})
		.catch((error: unknown) => ({ error }));

	return {
		startTime: normalizedStartTime,
		sourceUrl: audioSourceUrl,
		openResult,
		decodeCompletion,
		subscribe(listener) {
			for (const chunk of chunks) listener(chunk);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

const earlyPreparations = new Map<string, BrowserAudioPreparation>();

export function preloadBrowserAudioFallback(
	videoUrl: string,
	startTime: number,
	fileSize?: number,
	audioSourceUrl = videoUrl,
): BrowserAudioPreparation {
	const existing = earlyPreparations.get(videoUrl);
	if (
		existing &&
		existing.sourceUrl === audioSourceUrl &&
		Math.abs(existing.startTime - startTime) < 0.5
	) {
		return existing;
	}
	const preparation = prepareBrowserAudioFallback(
		videoUrl,
		startTime,
		fileSize,
		audioSourceUrl,
	);
	earlyPreparations.set(videoUrl, preparation);
	window.setTimeout(() => {
		if (earlyPreparations.get(videoUrl) === preparation) {
			earlyPreparations.delete(videoUrl);
		}
	}, 120000);
	return preparation;
}

export function takeBrowserAudioFallbackPreparation(
	videoUrl: string,
	startTime: number,
	fileSize?: number,
	audioSourceUrl = videoUrl,
): BrowserAudioPreparation {
	const existing = earlyPreparations.get(videoUrl);
	if (
		existing &&
		existing.sourceUrl === audioSourceUrl &&
		Math.abs(existing.startTime - startTime) < 0.5
	) {
		earlyPreparations.delete(videoUrl);
		return existing;
	}
	return prepareBrowserAudioFallback(
		videoUrl,
		startTime,
		fileSize,
		audioSourceUrl,
	);
}

export class BrowserAudioFallback {
	private readonly video: HTMLVideoElement;
	private readonly audioSourceUrl: string;
	private readonly notice?: (message: string) => void;
	private readonly preparation?: BrowserAudioPreparation;
	private context: AudioContext | null = null;
	private gain: GainNode | null = null;
	private active = false;
	private destroyed = false;
	private generation = 0;
	private pendingDecode = false;
	private sources = new Set<AudioBufferSourceNode>();
	private scheduledEndMedia = 0;
	private scheduledEndContext = 0;
	private anchorMedia = 0;
	private anchorContext = 0;
	private timer = 0;
	private primeTimer = 0;
	private bufferedChunks: BufferedAudioChunk[] = [];

	constructor(options: BrowserAudioFallbackOptions) {
		this.video = options.video;
		this.audioSourceUrl = options.audioSourceUrl ?? options.videoUrl;
		this.notice = options.notice;
		this.preparation = options.preparation;
	}

	async start(): Promise<boolean> {
		try {
			const result = this.preparation
				? await this.preparation.openResult
				: await request<AudioOpenResult>(
						"open",
						{ videoUrl: this.audioSourceUrl },
						100000,
					);
			if (this.destroyed || !result.supported) return false;
			this.active = true;
			this.context = new AudioContext({
				latencyHint: "interactive",
				sampleRate: result.sampleRate || undefined,
			});
			this.gain = this.context.createGain();
			this.gain.connect(this.context.destination);
			this.updateVolume();
			this.bindEvents();
			this.timer = window.setInterval(() => this.tick(), 250);
			const codecLabel = result.codec === "eac3" ? "E-AC-3" : "AC-3";
			this.notice?.(`${codecLabel} 浏览器音频兼容已启用`);
			if (this.preparation) this.consumePreparation(this.preparation);
			else if (this.video.paused) this.schedulePrime();
			else void this.resync();
			return true;
		} catch (error) {
			if (!this.destroyed) {
				console.warn("[cd2-artplayer] 浏览器音频兼容初始化失败:", error);
				this.notice?.(
					`音频兼容加载失败: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return false;
		}
	}

	private consumePreparation(preparation: BrowserAudioPreparation): void {
		const generation = this.generation;
		this.pendingDecode = true;
		const unsubscribe = preparation.subscribe((result) => {
			if (generation !== this.generation || this.destroyed) return;
			if (this.video.paused) {
				this.bufferedChunks.push({
					result,
					startTime: preparation.startTime,
					generation,
				});
				return;
			}
			this.scheduleChunk(
				result,
				preparation.startTime,
				generation,
				this.sources.size === 0,
			);
		});
		void preparation.decodeCompletion.then(({ error }) => {
			unsubscribe();
			this.pendingDecode = false;
			if (this.destroyed) return;
			if (error && generation === this.generation) {
				console.warn("[cd2-artplayer] 首段音频提前解码失败:", error);
			}
			if (this.video.paused) this.schedulePrime();
			else if (!this.sources.size) void this.resync();
		});
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.active = false;
		this.generation += 1;
		window.clearInterval(this.timer);
		window.clearTimeout(this.primeTimer);
		this.bufferedChunks = [];
		this.unbindEvents();
		this.stopSources();
		void this.context?.close().catch(() => undefined);
		this.context = null;
		this.gain = null;
		window.dispatchEvent(new CustomEvent("cd2-audio-fallback-close"));
	}

	private readonly onPlay = () => {
		window.clearTimeout(this.primeTimer);
		void this.context?.resume();
		if (this.bufferedChunks.length) {
			this.scheduleBufferedChunks();
			return;
		}
		// A pause-time predecode may still be in flight. Its first result will be
		// scheduled immediately by the existing callback without restarting it.
		if (!this.pendingDecode) void this.resync();
	};

	private readonly onPause = () => {
		this.generation += 1;
		this.stopSources();
		this.bufferedChunks = [];
		this.cancelPendingDecode();
		this.schedulePrime();
	};

	private readonly onSeeking = () => {
		this.generation += 1;
		this.stopSources();
		window.clearTimeout(this.primeTimer);
		this.bufferedChunks = [];
		this.cancelPendingDecode();
	};

	private readonly onSeeked = () => {
		if (this.video.paused) this.schedulePrime();
		else void this.resync();
	};

	private readonly onRateChange = () => {
		if (!this.video.paused) {
			this.cancelPendingDecode();
			void this.resync();
		}
	};

	private readonly onVolumeChange = () => this.updateVolume();

	private bindEvents(): void {
		this.video.addEventListener("play", this.onPlay);
		this.video.addEventListener("pause", this.onPause);
		this.video.addEventListener("seeking", this.onSeeking);
		this.video.addEventListener("seeked", this.onSeeked);
		this.video.addEventListener("ratechange", this.onRateChange);
		this.video.addEventListener("volumechange", this.onVolumeChange);
	}

	private unbindEvents(): void {
		this.video.removeEventListener("play", this.onPlay);
		this.video.removeEventListener("pause", this.onPause);
		this.video.removeEventListener("seeking", this.onSeeking);
		this.video.removeEventListener("seeked", this.onSeeked);
		this.video.removeEventListener("ratechange", this.onRateChange);
		this.video.removeEventListener("volumechange", this.onVolumeChange);
	}

	private updateVolume(): void {
		if (!this.gain || !this.context) return;
		const value = this.video.muted ? 0 : this.video.volume;
		this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
	}

	private stopSources(): void {
		for (const source of this.sources) {
			try {
				source.stop();
			} catch {
				// Source may already have ended.
			}
		}
		this.sources.clear();
		this.scheduledEndMedia = 0;
		this.scheduledEndContext = 0;
	}

	private cancelPendingDecode(): void {
		if (!this.pendingDecode) return;
		window.dispatchEvent(new CustomEvent("cd2-audio-fallback-cancel"));
	}

	private schedulePrime(): void {
		window.clearTimeout(this.primeTimer);
		const attempt = () => {
			if (
				this.destroyed ||
				!this.active ||
				!this.video.paused ||
				this.bufferedChunks.length
			) {
				return;
			}
			if (this.pendingDecode) {
				this.primeTimer = window.setTimeout(attempt, 50);
				return;
			}
			void this.decodeAndSchedule(this.video.currentTime, this.generation);
		};
		this.primeTimer = window.setTimeout(attempt, 0);
	}

	private scheduleBufferedChunks(): void {
		const chunks = this.bufferedChunks;
		this.bufferedChunks = [];
		for (const chunk of chunks) {
			this.scheduleChunk(
				chunk.result,
				chunk.startTime,
				chunk.generation,
				this.sources.size === 0,
			);
		}
	}

	private async resync(): Promise<void> {
		if (!this.active || this.destroyed || !this.context || !this.gain) return;
		const generation = ++this.generation;
		this.stopSources();
		try {
			await this.context.resume();
			if (
				generation !== this.generation ||
				this.destroyed ||
				this.video.paused
			) {
				return;
			}
			await this.decodeAndSchedule(this.video.currentTime, generation);
		} catch (error) {
			if (generation === this.generation && !this.destroyed) {
				console.warn("[cd2-artplayer] 音频同步失败:", error);
			}
		}
	}

	private async decodeAndSchedule(
		startTime: number,
		generation: number,
	): Promise<void> {
		if (this.pendingDecode || !this.context || !this.gain) return;
		this.pendingDecode = true;
		try {
			await request<AudioDecodeResult>(
				"decode",
				{ startTime, duration: SEGMENT_DURATION },
				120000,
				(result) => {
					if (generation !== this.generation || this.destroyed) return;
					if (this.video.paused) {
						this.bufferedChunks.push({ result, startTime, generation });
						return;
					}
					this.scheduleChunk(
						result,
						startTime,
						generation,
						this.sources.size === 0,
					);
				},
			);
		} finally {
			this.pendingDecode = false;
			if (
				this.active &&
				!this.destroyed &&
				!this.video.paused &&
				!this.sources.size
			) {
				queueMicrotask(() => void this.resync());
			}
		}
	}

	private scheduleChunk(
		result: AudioDecodeResult,
		startTime: number,
		generation: number,
		alignToVideo: boolean,
	): boolean {
		if (
			generation !== this.generation ||
			this.destroyed ||
			this.video.paused ||
			!this.context ||
			!this.gain ||
			!result.left ||
			!result.right ||
			!result.sampleRate ||
			result.startTime === undefined
		) {
			return false;
		}
		const left = new Float32Array(result.left);
		const right = new Float32Array(result.right);
		const length = Math.min(left.length, right.length);
		if (!length) return false;
		const buffer = this.context.createBuffer(2, length, result.sampleRate);
		buffer.copyToChannel(left.subarray(0, length), 0);
		buffer.copyToChannel(right.subarray(0, length), 1);

		const playbackRate = Math.max(0.25, this.video.playbackRate || 1);
		let offset = Math.max(0, startTime - result.startTime);
		if (alignToVideo)
			offset = Math.max(offset, this.video.currentTime - result.startTime);
		if (offset >= buffer.duration - 0.02) return false;
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.playbackRate.value = playbackRate;
		source.connect(this.gain);

		const mediaStart = result.startTime + offset;
		const hadScheduledAudio = this.sources.size > 0;
		const contextStart =
			alignToVideo || !hadScheduledAudio
				? this.context.currentTime + INITIAL_SCHEDULE_DELAY
				: Math.max(
						this.context.currentTime + APPEND_SCHEDULE_DELAY,
						this.scheduledEndContext,
					);
		if (alignToVideo || !hadScheduledAudio) {
			this.anchorMedia = mediaStart;
			this.anchorContext = contextStart;
		}
		source.start(contextStart, offset);
		this.sources.add(source);
		source.addEventListener("ended", () => this.sources.delete(source), {
			once: true,
		});
		this.scheduledEndMedia = result.startTime + buffer.duration;
		this.scheduledEndContext =
			contextStart + (buffer.duration - offset) / playbackRate;
		return true;
	}

	private tick(): void {
		if (
			!this.active ||
			this.destroyed ||
			this.video.paused ||
			this.video.seeking ||
			!this.context
		) {
			return;
		}
		// A remote MKV Range decode commonly takes longer than one timer tick.
		// Do not invalidate its generation while it is still in flight, otherwise
		// every completed first segment is discarded before it can be scheduled.
		if (!this.sources.size) {
			if (!this.pendingDecode) void this.resync();
			return;
		}
		const playbackRate = Math.max(0.25, this.video.playbackRate || 1);
		const expectedMedia =
			this.anchorMedia +
			(this.context.currentTime - this.anchorContext) * playbackRate;
		if (Math.abs(expectedMedia - this.video.currentTime) > MAX_DRIFT) {
			void this.resync();
			return;
		}
		if (
			!this.pendingDecode &&
			this.scheduledEndMedia - this.video.currentTime < REFILL_THRESHOLD
		) {
			void this.decodeAndSchedule(
				this.scheduledEndMedia,
				this.generation,
			).catch((error) => {
				if ((error as Error)?.message === "音频解码已取消") return;
				console.warn("[cd2-artplayer] 预读取下一段音频失败:", error);
			});
		}
	}
}
