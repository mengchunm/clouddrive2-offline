/**
 * 记忆存储模块
 *
 * 油猴脚本运行在沙箱中，直接使用 localStorage 有两个问题：
 * 1. 沙箱内 localStorage 与页面上下文的 localStorage 隔离
 * 2. 两个独立油猴脚本的沙箱 localStorage 互相隔离
 * 3. 脚本更新/重装时沙箱 localStorage 可能被清空
 *
 * 解决方案：
 * - 脚本内部数据(videoMemory) → GM_getValue/GM_setValue（持久可靠）
 * - 跨脚本共享数据(playlistMemory) → unsafeWindow.localStorage（页面上下文，两个脚本均可访问）
 */

import {
	GM_getValue,
	GM_setValue,
	unsafeWindow,
} from "vite-plugin-monkey/dist/client";

const MAX_RECORD_COUNT = 500;

export interface MemoryRecord<T> {
	data: T;
	updatedAt: number;
}

type StorageBackend = "gm" | "shared";

export class MemoryStore<T> {
	private key: string;
	private maxCount: number;
	private backend: StorageBackend;

	constructor(
		key: string,
		maxCount: number = MAX_RECORD_COUNT,
		backend: StorageBackend = "gm",
	) {
		this.key = key;
		this.maxCount = maxCount;
		this.backend = backend;
	}

	private readAll(): Record<string, MemoryRecord<T>> {
		try {
			if (this.backend === "gm") {
				return (GM_getValue(this.key, {}) as Record<string, MemoryRecord<T>>);
			}
			// shared: 使用 unsafeWindow.localStorage（页面上下文）
			const stored = unsafeWindow.localStorage.getItem(this.key);
			if (stored) return JSON.parse(stored);
		} catch (e) {
			console.warn("MemoryStore read failed", e);
		}
		return {};
	}

	private writeAll(data: Record<string, MemoryRecord<T>>) {
		try {
			const entries = Object.entries(data);
			let toWrite = data;
			if (entries.length > this.maxCount) {
				entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
				toWrite = Object.fromEntries(entries.slice(0, this.maxCount));
			}

			if (this.backend === "gm") {
				GM_setValue(this.key, toWrite);
			} else {
				unsafeWindow.localStorage.setItem(this.key, JSON.stringify(toWrite));
			}
		} catch (e) {
			console.warn("MemoryStore write failed", e);
		}
	}

	get(id: string): T | undefined {
		const all = this.readAll();
		return all[id]?.data;
	}

	set(id: string, data: T) {
		const all = this.readAll();
		all[id] = { data, updatedAt: Date.now() };
		this.writeAll(all);
	}
}

/** 跨脚本共享：文件夹→上次播放文件路径（offline 和 artplayer 都读写） */
export const playlistMemory = new MemoryStore<{ filePath: string }>("cd2_playlist_mem", 500, "shared");

/** 脚本内部：视频→播放进度 + 弹幕匹配信息 */
export const videoMemory = new MemoryStore<{ time: number; episodeId?: number; label?: string; useDirect?: boolean }>("cd2_video_mem", 2000, "gm");
