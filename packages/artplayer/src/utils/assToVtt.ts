function splitFields(value: string, count: number): string[] {
	const fields: string[] = [];
	let start = 0;
	for (let index = 0; index < count - 1; index += 1) {
		const comma = value.indexOf(",", start);
		if (comma < 0) return [];
		fields.push(value.slice(start, comma).trim());
		start = comma + 1;
	}
	fields.push(value.slice(start).trim());
	return fields;
}

function formatTimestamp(value: string): string | null {
	const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/);
	if (!match) return null;
	const fraction = match[4].padEnd(3, "0").slice(0, 3);
	return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${fraction}`;
}

function cleanText(value: string): string {
	return value
		.replace(/\{[^}]*\}/g, "")
		.replace(/\\N/gi, "\n")
		.replace(/\\h/gi, " ")
		.trim();
}

const DEFAULT_EVENT_FORMAT = [
	"layer",
	"start",
	"end",
	"style",
	"name",
	"marginl",
	"marginr",
	"marginv",
	"effect",
	"text",
];

/** 将 ASS/SSA 的 Dialogue 文本降级为无样式 WebVTT，供 libass 不可用时保底显示。 */
export function assToWebVtt(content: string): string {
	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	let inEvents = false;
	let format: string[] = [];
	let dialogueCount = 0;
	const cues: string[] = ["WEBVTT", ""];

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^\[Events\]$/i.test(trimmed)) {
			inEvents = true;
			continue;
		}
		if (/^\[[^\]]+\]$/.test(trimmed)) {
			inEvents = false;
			continue;
		}
		if (inEvents && /^Format\s*:/i.test(trimmed)) {
			format = trimmed
				.slice(trimmed.indexOf(":") + 1)
				.split(",")
				.map((field) => field.trim().toLowerCase());
			continue;
		}
		// Accept Dialogue lines outside [Events] as a compatibility fallback for
		// older Matroska assemblers that appended packet events at EOF.
		if (!/^Dialogue\s*:/i.test(trimmed)) continue;
		dialogueCount += 1;
		// 一些 Matroska 的 CodecPrivate 含 [Events] 却省略 Format。
		// ASS v4+/SSA v4 的常见字段中 Start/End/Text 位置一致，可安全保底解析。
		const eventFormat = format.length > 0 ? format : DEFAULT_EVENT_FORMAT;
		const fields = splitFields(
			trimmed.slice(trimmed.indexOf(":") + 1),
			eventFormat.length,
		);
		if (fields.length !== eventFormat.length) continue;
		const start = formatTimestamp(fields[eventFormat.indexOf("start")] ?? "");
		const end = formatTimestamp(fields[eventFormat.indexOf("end")] ?? "");
		const text = cleanText(fields[eventFormat.indexOf("text")] ?? "");
		if (!start || !end || !text) continue;
		cues.push(`${start} --> ${end}`, text, "");
	}

	if (cues.length === 2) {
		throw new Error(
			dialogueCount === 0
				? "ASS 中没有 Dialogue 字幕内容"
				: "ASS 中的 Dialogue 时间或字段格式无法识别",
		);
	}
	return cues.join("\n");
}
