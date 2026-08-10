import { Users } from "lucide-react";
import type { PeerClientView } from "../../../../shared/types";
import { LOCAL_PEER_ID } from "../../../../shared/types";
import { usePeerServerMetrics } from "../../hooks/usePeerServerMetrics";
import { Card, CardTitle } from "./Card";
import { NetworkLatencyInline } from "./NetworkLatency";
import { ServerInfo } from "./ServerInfo";

interface PeerServerCardProps {
	peer: PeerClientView;
}

/**
 * Wraps ServerInfo so each peer's CPU / memory / disk panel is driven by its
 * own polling hook. Throughput is local-only (it tracks this browser's WS
 * bytes), so it's only shown on the local peer card.
 */
export function PeerServerCard({ peer }: PeerServerCardProps) {
	const isLocal = peer.id === LOCAL_PEER_ID;
	const {
		systemMetrics,
		diskUsage,
		connectedClients,
		herdrUpdate,
		hrdleUpdate,
		error,
		refetch,
	} = usePeerServerMetrics(peer.id);

	return (
		<Card
			title={
				<div className="flex items-center gap-1.5 min-w-0">
					<span
						aria-hidden="true"
						className="w-2 h-2 rounded-full shrink-0"
						style={{ backgroundColor: peer.color }}
					/>
					<CardTitle>{peer.nickname}</CardTitle>
				</div>
			}
			aside={
				<div className="flex items-center gap-2 shrink-0">
					{error && (
						<span className="text-[10px] text-amber-400 truncate" title={error}>
							offline
						</span>
					)}
					{/* Local only: it measures this browser's link, so on a peer's card
					    it would be the wrong server's number under the right name. */}
					{isLocal && <NetworkLatencyInline />}
					<span
						className="flex items-center gap-1 text-[11px] text-teal-400 tabular-nums"
						title="Connected clients"
					>
						<Users className="w-3 h-3" />
						{connectedClients ?? 0}
					</span>
				</div>
			}
		>
			<ServerInfo
				systemMetrics={systemMetrics}
				diskUsage={diskUsage}
				hideThroughput={!isLocal}
				herdrUpdate={herdrUpdate}
				hrdleUpdate={hrdleUpdate}
				allowHerdrApply={isLocal}
				onHerdrApplied={refetch}
			/>
		</Card>
	);
}
