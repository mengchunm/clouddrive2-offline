import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateRawSync } from "node:zlib";

const outputDirectory = fileURLToPath(
	new URL("../public/icons/", import.meta.url),
);
const sourcePath = new URL("../public/icons/clouddrive.png", import.meta.url);
const sizes = [16, 32, 48, 128];

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBytes = Buffer.from(type, "ascii");
	const result = Buffer.alloc(data.length + 12);
	result.writeUInt32BE(data.length, 0);
	typeBytes.copy(result, 4);
	data.copy(result, 8);
	result.writeUInt32BE(
		crc32(Buffer.concat([typeBytes, data])),
		data.length + 8,
	);
	return result;
}

function encodePng(size, rgba) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 6;
	const scanlines = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++) {
		const offset = y * (size * 4 + 1);
		scanlines[offset] = 0;
		rgba.copy(scanlines, offset + 1, y * size * 4, (y + 1) * size * 4);
	}
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(scanlines, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function decodePng(input) {
	if (input.toString("ascii", 1, 4) !== "PNG")
		throw new Error("Original logo is not a PNG");

	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idat = [];
	for (let offset = 8; offset < input.length; ) {
		const length = input.readUInt32BE(offset);
		const type = input.toString("ascii", offset + 4, offset + 8);
		const data = input.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
		} else if (type === "IDAT") {
			idat.push(data);
		}
		offset += length + 12;
	}
	if (width <= 0 || height <= 0 || bitDepth !== 8 || colorType !== 6) {
		throw new Error("Original logo must be an 8-bit RGBA PNG");
	}

	const compressed = Buffer.concat(idat);
	if (compressed.length < 6) throw new Error("Original logo has no image data");
	const decoded = inflateRawSync(compressed.subarray(2, -4));
	const stride = width * 4;
	const pixels = Buffer.alloc(width * height * 4);
	let sourceOffset = 0;
	for (let y = 0; y < height; y++) {
		const filter = decoded[sourceOffset++];
		const rowStart = y * stride;
		for (let x = 0; x < stride; x++) {
			const raw = decoded[sourceOffset++];
			const left = x >= 4 ? pixels[rowStart + x - 4] : 0;
			const above = y > 0 ? pixels[rowStart - stride + x] : 0;
			const upperLeft = y > 0 && x >= 4 ? pixels[rowStart - stride + x - 4] : 0;
			let value = raw;
			if (filter === 1) value += left;
			else if (filter === 2) value += above;
			else if (filter === 3) value += Math.floor((left + above) / 2);
			else if (filter === 4) {
				const p = left + above - upperLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - above);
				const pc = Math.abs(p - upperLeft);
				value += pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
			}
			pixels[rowStart + x] = value & 0xff;
		}
	}
	return { width, height, pixels };
}

function resizeBilinear(source, size) {
	const output = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const sourceY = ((y + 0.5) * source.height) / size - 0.5;
		const y0 = Math.max(0, Math.floor(sourceY));
		const y1 = Math.min(source.height - 1, y0 + 1);
		const yWeight = Math.max(0, Math.min(1, sourceY - y0));
		for (let x = 0; x < size; x++) {
			const sourceX = ((x + 0.5) * source.width) / size - 0.5;
			const x0 = Math.max(0, Math.floor(sourceX));
			const x1 = Math.min(source.width - 1, x0 + 1);
			const xWeight = Math.max(0, Math.min(1, sourceX - x0));
			const outputOffset = (y * size + x) * 4;
			for (let channel = 0; channel < 4; channel++) {
				const topLeft = source.pixels[(y0 * source.width + x0) * 4 + channel];
				const topRight = source.pixels[(y0 * source.width + x1) * 4 + channel];
				const bottomLeft =
					source.pixels[(y1 * source.width + x0) * 4 + channel];
				const bottomRight =
					source.pixels[(y1 * source.width + x1) * 4 + channel];
				const top = topLeft + (topRight - topLeft) * xWeight;
				const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
				output[outputOffset + channel] = Math.round(
					top + (bottom - top) * yWeight,
				);
			}
		}
	}
	return output;
}

const original = decodePng(readFileSync(sourcePath));
mkdirSync(outputDirectory, { recursive: true });
for (const size of sizes)
	writeFileSync(
		`${outputDirectory}/icon-${size}.png`,
		encodePng(size, resizeBilinear(original, size)),
	);
console.log(
	`Generated CloudDrive2 Offline icons from clouddrive.png: ${sizes.join(", ")} px`,
);
