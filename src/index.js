import SlotCell from "./cell/SlotCell.js";
import { fail } from "./lib/response.js";

export { SlotCell };

const WORKSPACE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export default {
	async fetch(request, env, ctx) {
		const workspaceId = request.headers.get("X-Workspace-ID")?.trim();
		if (!workspaceId || !WORKSPACE_DATE_REGEX.test(workspaceId)) {
			return fail(
				{ message: "Header X-Workspace-ID wajib berformat YYYY-MM-DD" },
				400
			);
		}

		const id = env.SLOT_CELL.idFromName(workspaceId);
		const stub = env.SLOT_CELL.get(id);
		return stub.fetch(request);
	}
};
