import SlotCell from "./cell/SlotCell.js";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/**
 * Env provides a mechanism to reference bindings declared in wrangler.jsonc within JavaScript
 *
 * @typedef {Object} Env
 * @property {DurableObjectNamespace} MY_DURABLE_OBJECT - The Durable Object namespace binding
 */
export { SlotCell };
/** A Durable Object's behavior is defined in an exported Javascript class */

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param {Request} request - The request submitted to the Worker from the client
	 * @param {Env} env - The interface to reference bindings declared in wrangler.jsonc
	 * @param {ExecutionContext} ctx - The execution context of the Worker
	 * @returns {Promise<Response>} The response to be sent back to the client
	 */
	// async fetch(request, env, ctx) {
	// 	// use Slotcell Durable Object to handle requests
		
	// 	const id = env.SLOT_CELL.idFromName("slotcell");
	// 	const stub = env.SLOT_CELL.get(id);
	// 	return stub.fetch(request);
	// },

	async fetch(request, env, ctx) {
		// 1. Ambil identitas cell dari header
		const workspaceId = request.headers.get("X-Workspace-ID");
		if (!workspaceId) {
			return Response.json({ error: "Header X-Workspace-ID wajib diisi" }, { status: 400 });
		}

		// 2. Buat ID dan ambil stub berdasarkan workspaceId tersebut
		const id = env.SLOT_CELL.idFromName(workspaceId);
		const stub = env.SLOT_CELL.get(id);

		// (Atau bisa disingkat jadi 1 baris dengan method baru Cloudflare):
		// const stub = env.SLOT_CELL.getByName(workspaceId);

		// 3. Panggil method di dalam SlotCell (pilih salah satu pola di bawah):
		
		// Pola A: Pakai RPC method (seperti sayHello di awal)
		const result = await stub.fetch(request);
		return result;
		
		// Pola B: Teruskan seluruh HTTP request ke dalam method fetch() milik SlotCell
		// return stub.fetch(request);
	}
};
