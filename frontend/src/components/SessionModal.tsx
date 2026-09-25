import { useCallback, useEffect, useState } from "react";
import type { SessionResponse } from "../../../shared/types";
import { DashboardPanel } from "./DashboardPanel";
import { WorkspaceList } from "./WorkspaceList";

interface SessionModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSelectSession: (session: SessionResponse) => void;
	isTablet?: boolean;
}

export function SessionModal({
	isOpen,
	onClose,
	onSelectSession,
	isTablet,
}: SessionModalProps) {
	const [showDashboard, setShowDashboard] = useState(false);

	// Close on Escape
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose]);

	const handleSelectSession = useCallback(
		(session: SessionResponse) => {
			onSelectSession(session);
			onClose();
		},
		[onSelectSession, onClose],
	);

	if (!isOpen) return null;

	// Desktop only: scale up. Tablet keeps native size so touch targets are
	// unchanged. Applied per-column so the dashboard panel (which self-zooms via
	// its own isTablet) isn't double-scaled.
	const desktopZoom = isTablet ? undefined : { zoom: 1.25 };

	return (
		<div className="fixed inset-0 z-50 flex bg-[#0a0a0a]">
			{/* Workspace list: takes the free space and shrinks to the left when the
			    dashboard opens, so it stays fully visible beside the panel instead
			    of being covered by it. */}
			<div
				className="flex-1 min-w-0 min-h-0 overflow-hidden h-full"
				style={desktopZoom}
			>
				<WorkspaceList
					onSelectSession={handleSelectSession}
					onClose={onClose}
					onToggleDashboard={() => setShowDashboard((v) => !v)}
					dashboardOpen={showDashboard}
				/>
			</div>

			{/* Dashboard side panel (right) */}
			{showDashboard && (
				<DashboardPanel
					isOpen={true}
					onClose={() => setShowDashboard(false)}
					isTablet={isTablet}
				/>
			)}
		</div>
	);
}
