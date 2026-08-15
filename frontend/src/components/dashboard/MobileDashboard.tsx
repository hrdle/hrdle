import { BarChart3, Server, X } from "lucide-react";
import { useState } from "react";
import { PeerManager } from "../PeerManager";
import { Dashboard } from "./Dashboard";

interface MobileDashboardProps {
	onClose: () => void;
}

/**
 * The dashboard on a phone: the whole screen, because half of 393px is not a
 * dashboard.
 *
 * z-[70] so it also covers the session list (z-[60]) - the list header has a
 * dashboard button of its own, and closing this drops the reader back onto
 * whichever of the two opened it.
 */
export function MobileDashboard({ onClose }: MobileDashboardProps) {
	const [tab, setTab] = useState<"dashboard" | "peers">("dashboard");

	return (
		<div className="fixed inset-0 z-[70] flex flex-col bg-[#0a0a0a] animate-modal-in">
			<div className="shrink-0 px-4 pt-3 pb-3 border-b border-white/[0.06]">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-0.5">
						<button
							type="button"
							onClick={() => setTab("dashboard")}
							className={`px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
								tab === "dashboard"
									? "bg-white/[0.08] text-white"
									: "text-zinc-400 hover:text-zinc-200"
							}`}
						>
							<BarChart3 className="w-4 h-4" />
							Dashboard
						</button>
						<button
							type="button"
							onClick={() => setTab("peers")}
							className={`px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
								tab === "peers"
									? "bg-white/[0.08] text-white"
									: "text-zinc-400 hover:text-zinc-200"
							}`}
						>
							<Server className="w-4 h-4" />
							Servers
						</button>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
					>
						<X className="w-5 h-5" />
					</button>
				</div>
			</div>
			{/* Dashboard brings its own scroller; nesting a second one here made a
			    flick land on whichever the finger happened to be over. */}
			<div className="flex-1 min-h-0 flex flex-col">
				{tab === "dashboard" ? (
					<Dashboard className="flex-1 min-h-0" />
				) : (
					<div className="flex-1 min-h-0 overflow-y-auto">
						<PeerManager />
					</div>
				)}
			</div>
		</div>
	);
}
