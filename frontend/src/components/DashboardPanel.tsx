import { X, Server, BarChart3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dashboard } from "./dashboard/Dashboard";
import { PeerManager } from "./PeerManager";

interface DashboardPanelProps {
	isOpen: boolean;
	onClose: () => void;
	isTablet?: boolean;
}

type PanelTab = "dashboard" | "peers";

export function DashboardPanel({
	isOpen,
	onClose,
	isTablet,
}: DashboardPanelProps) {
	const { t } = useTranslation();
	const [tab, setTab] = useState<PanelTab>("dashboard");

	if (!isOpen) return null;

	// Desktop typography is too small for monitor viewing distance — scale the
	// panel up. Tablets stay at native size so finger reach areas aren't
	// distorted.
	const desktopZoom = isTablet ? undefined : { zoom: 1.25 };

	return (
		<div
			className="w-[360px] xl:w-[420px] 2xl:w-[480px] shrink-0 flex flex-col bg-th-bg border-l border-th-border z-[60]"
			style={desktopZoom}
		>
			{/* Header */}
			<div className="shrink-0 px-4 pt-3 pb-3 border-b border-white/[0.06]">
				<div className="flex items-center justify-between max-w-lg">
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
							{t("dashboard.title")}
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
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={onClose}
							className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
						>
							<X className="w-[18px] h-[18px]" />
						</button>
					</div>
				</div>
			</div>

			{/* Content. Dashboard scrolls itself, so this wrapper must not — two
			    nested scrollers meant a flick could move either one, and which
			    depended on where the finger landed. */}
			<div className="flex-1 min-h-0 flex flex-col">
				{tab === "dashboard" ? (
					<Dashboard className="flex-1 min-h-0" compact />
				) : (
					<div className="flex-1 min-h-0 overflow-y-auto">
						<PeerManager />
					</div>
				)}
			</div>
		</div>
	);
}
