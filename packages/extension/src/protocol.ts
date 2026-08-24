export interface FetchProxyRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	bodyBase64?: string;
	timeout?: number;
}

export interface FetchProxyResponse {
	ok: boolean;
	status?: number;
	statusText?: string;
	headers?: string;
	bodyBase64?: string;
	error?: string;
}

export interface FetchProxyMessage {
	type: "cd2-fetch";
	request: FetchProxyRequest;
}

export type ExtensionCommandId = "danmu-api" | "danmu-mode" | "close-player";

export interface RunCommandMessage {
	type: "cd2-run-command";
	command: ExtensionCommandId;
}

export interface GetCommandStateMessage {
	type: "cd2-get-command-state";
}

export interface CommandStateResponse {
	ok: boolean;
	availableCommands: ExtensionCommandId[];
}

export interface OpenOptionsMessage {
	type: "cd2-open-options";
}

export interface TrackTaskRootMessage {
	type: "cd2-track-task-root";
	taskKey: string;
	fileId: string;
	path: string;
	verified?: boolean;
}

export interface MarkTaskRootDeletedMessage {
	type: "cd2-mark-task-root-deleted";
	taskKey: string;
}

export interface OpenLocalPathMessage {
	type: "cd2-open-local-path";
	localPath: string;
	reveal?: boolean;
}

export interface OpenLocalPathResponse {
	ok: boolean;
	error?: string;
}

export interface PlayPotPlayerPlaylistMessage {
	type: "cd2-play-potplayer-playlist";
	title: string;
	startUrl: string;
	entries: { url: string; fileName: string }[];
}

export interface NativeStatusMessage {
	type: "cd2-native-status";
}

export interface NativeUninstallMessage {
	type: "cd2-native-uninstall";
}
