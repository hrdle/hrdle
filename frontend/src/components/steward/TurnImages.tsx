import { useAuthBlobUrl } from "../../hooks/useAuthBlobUrl";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * The pictures attached to one entry.
 *
 * Served by name from the upload directory rather than by path: that endpoint
 * only reads from there, so a path from anywhere else draws nothing instead of
 * reaching into the filesystem.
 */
export function TurnImages({ paths, onLoad }: { paths: string[]; onLoad?: () => void }) {
	if (paths.length === 0) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{paths.map((path) => (
				<TurnImage key={path} path={path} onLoad={onLoad} />
			))}
		</div>
	);
}

function TurnImage({ path, onLoad }: { path: string; onLoad?: () => void }) {
	const name = path.split("/").pop() ?? "";
	const ok = /^[\w\-.]+\.(png|jpg|jpeg|gif|webp)$/i.test(name);
	// A blob URL, because `/api/files` is header-only auth and an <img src>
	// carries no header.
	const src = useAuthBlobUrl(
		ok ? `${API_BASE}/api/files/images/${encodeURIComponent(name)}` : null,
	);

	if (!ok) return <p className="break-all font-mono text-cv-text-muted text-xs">{path}</p>;

	// A box while it arrives. Rendering nothing meant a message appeared with no
	// sign a picture was coming, and on a phone over LTE these are seconds
	// apart - 460KB of screenshots at the ~100KB/s the status bar was showing.
	// The message read as one that had been sent without its images.
	if (!src) {
		return (
			<div
				aria-busy="true"
				className="h-24 w-32 animate-pulse rounded-md bg-cv-surface-hover"
			/>
		);
	}

	return (
		<button
			type="button"
			// The conversation viewer's lightbox only listens while it is mounted,
			// and it is not here. A tab is the one enlargement that always works.
			onClick={() => window.open(src, "_blank", "noopener")}
			className="block"
		>
			<img src={src} alt={name} onLoad={onLoad} className="max-h-48 rounded-md object-contain" />
		</button>
	);
}
