import { Plus, Trash2, RefreshCw, Pencil, Server, Wifi, WifiOff, AlertTriangle, X, Search, CheckCircle2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	LOCAL_PEER_ID,
	type DiscoveredPeer,
	type PeerClientView,
	type PeerDiscoverResponse,
} from "../../../shared/types";
import { usePeers } from "../hooks/usePeers";
import { authFetch } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

const COLOR_OPTIONS = [
	"#10b981", "#3b82f6", "#f59e0b", "#ec4899",
	"#8b5cf6", "#06b6d4", "#f97316", "#84cc16",
	"#ef4444", "#a855f7", "#14b8a6", "#eab308",
];

function StatusBadge({ peer }: { peer: PeerClientView }) {
	if (peer.id === LOCAL_PEER_ID) {
		return (
			<span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 inline-flex items-center gap-1">
				<Server className="w-3 h-3" /> local
			</span>
		);
	}
	switch (peer.status) {
		case "online":
			return (
				<span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 inline-flex items-center gap-1">
					<Wifi className="w-3 h-3" /> online
				</span>
			);
		case "offline":
			return (
				<span className="text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 inline-flex items-center gap-1">
					<WifiOff className="w-3 h-3" /> offline
				</span>
			);
		case "unauthorized":
			return (
				<span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 inline-flex items-center gap-1">
					<AlertTriangle className="w-3 h-3" /> auth required
				</span>
			);
		default:
			return <span className="text-xs px-2 py-0.5 rounded-full bg-th-surface-hover text-th-text-muted">unknown</span>;
	}
}

function ColorSwatch({ color, selected, onClick }: { color: string; selected: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-7 h-7 rounded-full border-2 transition-transform ${
				selected ? "border-th-text scale-110" : "border-transparent hover:scale-105"
			}`}
			style={{ backgroundColor: color }}
			aria-label={`Color ${color}`}
		/>
	);
}

interface AddFormProps {
	onSubmit: (input: { nickname: string; url: string; password: string; color?: string }) => Promise<void>;
	onCancel: () => void;
	initialNickname?: string;
	initialUrl?: string;
}

function AddPeerForm({ onSubmit, onCancel, initialNickname, initialUrl }: AddFormProps) {
	const [nickname, setNickname] = useState(initialNickname ?? "");
	const [url, setUrl] = useState(initialUrl ?? "https://");
	const [password, setPassword] = useState("");
	const [color, setColor] = useState<string | undefined>(undefined);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit({ nickname, url, password, color });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to register the server");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="bg-th-surface-hover border border-th-border rounded-md p-4 space-y-3">
			<div className="flex items-center justify-between mb-2">
				<h3 className="font-semibold text-th-text">Add a server</h3>
				<button type="button" onClick={onCancel} className="text-th-text-muted hover:text-th-text">
					<X className="w-4 h-4" />
				</button>
			</div>
			<div>
				<label htmlFor="peer-nickname" className="block text-xs text-th-text-secondary mb-1">Nickname (emoji allowed)</label>
				<input
					id="peer-nickname"
					type="text"
					value={nickname}
					onChange={(e) => setNickname(e.target.value)}
					placeholder="💻 MacBook Air"
					required
					className="w-full px-3 py-2 bg-th-surface border border-th-border rounded-md text-th-text"
				/>
			</div>
			<div>
				<label htmlFor="peer-url" className="block text-xs text-th-text-secondary mb-1">URL</label>
				<input
					id="peer-url"
					type="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://mac.tailnet.ts.net:5923"
					required
					className="w-full px-3 py-2 bg-th-surface border border-th-border rounded-md text-th-text font-mono text-sm"
				/>
			</div>
			<div>
				<label htmlFor="peer-password" className="block text-xs text-th-text-secondary mb-1">
					Password for that server
					<span className="ml-1 text-th-text-muted">(leave empty if the peer has auth disabled)</span>
				</label>
				<input
					id="peer-password"
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					className="w-full px-3 py-2 bg-th-surface border border-th-border rounded-md text-th-text"
				/>
			</div>
			<div>
				<div className="block text-xs text-th-text-secondary mb-1">Badge color (optional: assigned automatically)</div>
				<div className="flex flex-wrap gap-2">
					{COLOR_OPTIONS.map((c) => (
						<ColorSwatch key={c} color={c} selected={color === c} onClick={() => setColor(c === color ? undefined : c)} />
					))}
				</div>
			</div>
			{error && <div className="text-red-400 text-sm bg-red-900/20 p-2 rounded">{error}</div>}
			<div className="flex gap-2">
				<button
					type="submit"
					disabled={submitting}
					className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-md transition-colors"
				>
					{submitting ? "Checking..." : "Add"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="py-2 px-4 bg-th-surface hover:bg-th-surface-hover border border-th-border text-th-text rounded-md"
				>
					Cancel
				</button>
			</div>
		</form>
	);
}

interface EditFormProps {
	peer: PeerClientView;
	onSubmit: (input: { nickname?: string; color?: string; password?: string }) => Promise<void>;
	onCancel: () => void;
}

function EditPeerForm({ peer, onSubmit, onCancel }: EditFormProps) {
	const [nickname, setNickname] = useState(peer.nickname);
	const [color, setColor] = useState(peer.color);
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const input: { nickname?: string; color?: string; password?: string } = {};
			if (nickname !== peer.nickname) input.nickname = nickname;
			if (color !== peer.color) input.color = color;
			if (password) input.password = password;
			await onSubmit(input);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update the server");
		} finally {
			setSubmitting(false);
		}
	};

	const isLocal = peer.id === LOCAL_PEER_ID;

	return (
		<form onSubmit={handleSubmit} className="bg-th-surface-hover border border-th-border rounded-md p-4 space-y-3">
			<div className="flex items-center justify-between mb-2">
				<h3 className="font-semibold text-th-text">Edit server</h3>
				<button type="button" onClick={onCancel} className="text-th-text-muted hover:text-th-text">
					<X className="w-4 h-4" />
				</button>
			</div>
			<div>
				<label htmlFor="edit-nickname" className="block text-xs text-th-text-secondary mb-1">Nickname</label>
				<input
					id="edit-nickname"
					type="text"
					value={nickname}
					onChange={(e) => setNickname(e.target.value)}
					required
					className="w-full px-3 py-2 bg-th-surface border border-th-border rounded-md text-th-text"
				/>
			</div>
			<div>
				<div className="block text-xs text-th-text-secondary mb-1">Badge color</div>
				<div className="flex flex-wrap gap-2">
					{COLOR_OPTIONS.map((c) => (
						<ColorSwatch key={c} color={c} selected={color === c} onClick={() => setColor(c)} />
					))}
				</div>
			</div>
			{!isLocal && (
				<div>
					<label htmlFor="edit-password" className="block text-xs text-th-text-secondary mb-1">
						Password (only when re-authenticating)
					</label>
					<input
						id="edit-password"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						className="w-full px-3 py-2 bg-th-surface border border-th-border rounded-md text-th-text"
					/>
				</div>
			)}
			{error && <div className="text-red-400 text-sm bg-red-900/20 p-2 rounded">{error}</div>}
			<div className="flex gap-2">
				<button
					type="submit"
					disabled={submitting}
					className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-md transition-colors"
				>
					{submitting ? "Saving..." : "Save"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="py-2 px-4 bg-th-surface hover:bg-th-surface-hover border border-th-border text-th-text rounded-md"
				>
					Cancel
				</button>
			</div>
		</form>
	);
}

export function PeerManager() {
	const { peers, isLoading, error, refresh, addPeer, updatePeer, deletePeer, verifyPeer } = usePeers();
	const [adding, setAdding] = useState(false);
	const [addPrefill, setAddPrefill] = useState<{ nickname: string; url: string } | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [verifyingId, setVerifyingId] = useState<string | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredPeer[] | null>(null);
	const [discoverError, setDiscoverError] = useState<string | null>(null);

	const handleAdd = async (input: { nickname: string; url: string; password: string; color?: string }) => {
		await addPeer(input);
		setAdding(false);
		setAddPrefill(null);
	};

	const handleDiscover = async () => {
		// Ask every time, so this never looks like an unannounced port scan on a
		// network that is not the tailnet.
		const ok = confirm(
			"This sends an HTTP request to :5923 (hrdle's default port) on every host in the Tailscale tailnet to see which of them run hrdle.\n\n" +
				"Nothing is sent to hosts outside Tailscale. Continue?",
		);
		if (!ok) return;

		setDiscovering(true);
		setDiscoverError(null);
		try {
			const res = await authFetch(`${API_BASE}/api/peers/discover`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as PeerDiscoverResponse;
			setDiscovered(data.discovered);
		} catch (err) {
			setDiscoverError(err instanceof Error ? err.message : "Discovery failed");
		} finally {
			setDiscovering(false);
		}
	};

	const handlePickDiscovered = (d: DiscoveredPeer) => {
		if (d.alreadyRegistered) return;
		setAddPrefill({ nickname: d.displayName, url: d.url });
		setAdding(true);
		setDiscovered(null);
	};

	const handleEdit = async (id: string, input: { nickname?: string; color?: string; password?: string }) => {
		await updatePeer(id, input);
		setEditingId(null);
	};

	const handleDelete = async (peer: PeerClientView) => {
		if (peer.id === LOCAL_PEER_ID) return;
		if (!confirm(`Remove ${peer.nickname}?`)) return;
		await deletePeer(peer.id);
	};

	const handleVerify = async (peer: PeerClientView) => {
		setVerifyingId(peer.id);
		try {
			await verifyPeer(peer.id);
		} catch {
			/* the error surfaces through peer.status */
		} finally {
			setVerifyingId(null);
		}
	};

	return (
		<div className="space-y-4 p-4">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="text-lg font-semibold text-th-text">Servers (peers)</h2>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => void refresh()}
						className="p-2 rounded-md bg-th-surface-hover hover:bg-th-surface text-th-text-secondary"
						title="Reload"
					>
						<RefreshCw className="w-4 h-4" />
					</button>
					<button
						type="button"
						onClick={() => void handleDiscover()}
						disabled={discovering}
						className="px-3 py-2 rounded-md bg-th-surface-hover hover:bg-th-surface text-th-text text-sm font-medium inline-flex items-center gap-1 disabled:opacity-50"
						title="Search the Tailscale network"
					>
						<Search className={`w-4 h-4 ${discovering ? "animate-pulse" : ""}`} />
						{discovering ? "Searching..." : "Discover"}
					</button>
					<button
						type="button"
						onClick={() => { setAddPrefill(null); setAdding(true); }}
						disabled={adding}
						className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white text-sm font-medium inline-flex items-center gap-1"
					>
						<Plus className="w-4 h-4" /> Add server
					</button>
				</div>
			</div>

			{error && <div className="text-red-400 text-sm bg-red-900/20 p-3 rounded">{error}</div>}
			{discoverError && (
				<div className="text-red-400 text-sm bg-red-900/20 p-3 rounded">
					Discovery error: {discoverError}
				</div>
			)}

			{discovered !== null && (
				<div className="bg-th-surface-hover border border-th-border rounded-md p-3 space-y-2">
					<div className="flex items-center justify-between mb-2">
						<h3 className="font-semibold text-th-text inline-flex items-center gap-1">
							<Search className="w-4 h-4" /> hrdle on the network ({discovered.length})
						</h3>
						<button
							type="button"
							onClick={() => setDiscovered(null)}
							className="text-th-text-muted hover:text-th-text"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
					{discovered.length === 0 ? (
						<p className="text-sm text-th-text-muted py-2">
							No unregistered hrdle instance was found.<br />
							<span className="text-xs">Only peers Tailscale reports as online are probed, on port 5923.</span>
						</p>
					) : (
						<ul className="space-y-1">
							{discovered.map((d) => (
								<li
									key={d.hostname}
									className={`flex items-center justify-between gap-2 p-2 rounded ${
										d.alreadyRegistered ? "opacity-50" : "hover:bg-th-surface cursor-pointer"
									}`}
									onClick={() => handlePickDiscovered(d)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											handlePickDiscovered(d);
										}
									}}
								>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium text-th-text truncate">{d.displayName}</span>
											{d.version && (
												<span className="text-xs px-1.5 py-0.5 rounded bg-th-surface text-th-text-muted">
													v{d.version}
												</span>
											)}
											{d.alreadyRegistered && (
												<span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 inline-flex items-center gap-1">
													<CheckCircle2 className="w-3 h-3" /> Registered
												</span>
											)}
										</div>
										<div className="text-xs text-th-text-muted font-mono truncate mt-0.5">
											{d.hostname}
											{d.alreadyRegistered && d.registeredAs && (
												<span className="ml-2">→ {d.registeredAs}</span>
											)}
										</div>
									</div>
									{!d.alreadyRegistered && (
										<button
											type="button"
											className="shrink-0 px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium inline-flex items-center gap-1"
										>
											<Plus className="w-3 h-3" /> Add
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{adding && (
				<AddPeerForm
					onSubmit={handleAdd}
					onCancel={() => { setAdding(false); setAddPrefill(null); }}
					initialNickname={addPrefill?.nickname}
					initialUrl={addPrefill?.url}
				/>
			)}

			{isLoading ? (
				<div className="text-th-text-muted text-sm">Loading...</div>
			) : (
				<ul className="space-y-2">
					{peers.map((peer) => (
						<li
							key={peer.id}
							className="bg-th-surface border-l-4 border border-th-border rounded-md overflow-hidden"
							style={{ borderLeftColor: peer.color }}
						>
							{editingId === peer.id ? (
								<EditPeerForm
									peer={peer}
									onSubmit={(input) => handleEdit(peer.id, input)}
									onCancel={() => setEditingId(null)}
								/>
							) : (
								<div className="p-3 flex items-center justify-between gap-3">
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium text-th-text truncate">{peer.nickname}</span>
											<StatusBadge peer={peer} />
										</div>
										<div className="text-xs text-th-text-muted font-mono truncate mt-0.5">
											{peer.url === "self" ? "(this server)" : peer.url}
										</div>
										{peer.errorMessage && (
											<div className="text-xs text-red-400 mt-0.5">{peer.errorMessage}</div>
										)}
									</div>
									<div className="flex items-center gap-1 shrink-0">
										{peer.id !== LOCAL_PEER_ID && (
											<button
												type="button"
												onClick={() => handleVerify(peer)}
												disabled={verifyingId === peer.id}
												className="p-2 rounded hover:bg-th-surface-hover text-th-text-muted"
												title="Check connectivity"
											>
												<RefreshCw className={`w-4 h-4 ${verifyingId === peer.id ? "animate-spin" : ""}`} />
											</button>
										)}
										<button
											type="button"
											onClick={() => setEditingId(peer.id)}
											className="p-2 rounded hover:bg-th-surface-hover text-th-text-muted"
											title="Edit"
										>
											<Pencil className="w-4 h-4" />
										</button>
										{peer.id !== LOCAL_PEER_ID && (
											<button
												type="button"
												onClick={() => handleDelete(peer)}
												className="p-2 rounded hover:bg-red-900/30 text-red-400"
												title="Remove"
											>
												<Trash2 className="w-4 h-4" />
											</button>
										)}
									</div>
								</div>
							)}
						</li>
					))}
				</ul>
			)}

			<p className="text-xs text-th-text-muted">
				Note: the hub logs in to each peer it adds and stores the token.<br />
				Note: nothing has to change on the peer's own server.
			</p>
		</div>
	);
}
