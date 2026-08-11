import { useEffect, useMemo } from "react";

interface HtmlViewerProps {
	content: string;
	fileName: string;
}

export function HtmlViewer({ content, fileName }: HtmlViewerProps) {
	// Create blob URL for iframe (memoized to prevent reload on re-render)
	const blobUrl = useMemo(() => {
		const blob = new Blob([content], { type: "text/html" });
		return URL.createObjectURL(blob);
	}, [content]);

	// Cleanup blob URL on unmount or content change
	useEffect(() => {
		return () => {
			URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	return (
		<div className="h-full flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-th-border bg-th-surface/50">
				<span className="text-sm text-th-text-secondary">{fileName}</span>
				<span className="text-xs text-th-text-muted">HTML Preview</span>
			</div>

			{/* Content */}
			<div className="flex-1 bg-white">
				{/* sandbox="allow-scripts" without allow-same-origin gives the
				    frame a unique opaque origin, so a malicious preview HTML cannot
				    reach window.parent.localStorage (auth token) or hit the hrdle
				    API as the logged-in user. */}
				<iframe
					src={blobUrl}
					className="w-full h-full border-0"
					sandbox="allow-scripts"
					title={fileName}
				/>
			</div>
		</div>
	);
}
