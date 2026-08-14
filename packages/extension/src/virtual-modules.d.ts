declare module "virtual:cd2-libav-factory" {
	const factory: (
		options?: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
	export default factory;
}

declare module "virtual:cd2-libav-wasm-base64" {
	const base64: string;
	export default base64;
}
