import { Download, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileChange, FileContent } from "../../../../shared/types";
import type { SelectedGitDiff, ViewMode } from "../../hooks/useViewHistory";
import { CodeViewer } from "./CodeViewer";
import { DiffViewer } from "./DiffViewer";
import {
	getFileName,
	isHtmlFile,
	isImageFile,
	isMarkdownFile,
	isMediaFile,
	isModelFile,
	isVideoFile,
} from "./file-types";
import { HtmlViewer } from "./HtmlViewer";
import { ImageViewer } from "./ImageViewer";
import { getLanguageFromPath } from "./language-detect";
import { MarkdownViewer } from "./MarkdownViewer";
import { StlViewer } from "./StlViewer";

interface FileContentViewProps {
	viewMode: ViewMode;
	selectedFile: FileContent | null;
	selectedChange: FileChange | null;
	selectedGitDiff: SelectedGitDiff | null;
	previewMode: boolean;
	/** Same-origin blob: URL for image/media, fetched with auth. */
	rawBlobUrl: string | null;
	scrollRatio: number;
	onScrollRatioChange: (ratio: number) => void;
	onCopyPrompt?: (text: string) => void;
	/** Switch a markdown/html source view into preview mode. */
	onEnablePreview: () => void;
	sessionWorkingDir: string;
	/** API prefix matching the peer (`/api/files` or `/api/peers/<id>/files`). */
	filesApiBase: string;
	/** Download the current file (used by the binary placeholder). */
	onDownload?: () => void;
}

function MediaContent({
	file,
	rawBlobUrl,
}: {
	file: FileContent;
	rawBlobUrl: string | null;
}) {
	return (
		<div className="flex flex-col h-full bg-th-bg">
			<div className="flex-1 flex items-center justify-center overflow-hidden p-2">
				{isVideoFile(file.path) ? (
					// biome-ignore lint/a11y/useMediaCaption: arbitrary user files; no caption track available
					<video
						controls
						playsInline
						preload="metadata"
						className="w-full h-full object-contain rounded"
						src={rawBlobUrl ?? undefined}
					/>
				) : (
					// biome-ignore lint/a11y/useMediaCaption: arbitrary user files; no caption track available
					<audio
						controls
						preload="metadata"
						className="w-full max-w-md"
						src={rawBlobUrl ?? undefined}
					/>
				)}
			</div>
			<div className="px-3 py-1.5 text-xs text-th-text-muted text-center border-t border-th-border">
				{getFileName(file.path)} •{" "}
				{file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ""}
			</div>
		</div>
	);
}

function BinaryPlaceholder({
	file,
	onDownload,
}: {
	file: FileContent;
	onDownload?: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-th-text-muted">
			<FileText className="w-12 h-12" strokeWidth={1.5} />
			<div className="text-center">
				<div className="text-sm text-th-text-secondary break-all">
					{getFileName(file.path)}
				</div>
				<div className="text-xs mt-1">{t("files.binaryNotSupported")}</div>
			</div>
			{onDownload && (
				<button
					type="button"
					onClick={onDownload}
					className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-th-surface-hover hover:bg-th-surface-active text-th-text transition-colors"
				>
					<Download className="w-4 h-4" />
					{t("files.download")}
				</button>
			)}
		</div>
	);
}

/**
 * The single source of truth for rendering file/diff content. Both the
 * wide (two-pane) and mobile (single-pane) layouts of FileViewer render this,
 * eliminating the previously duplicated image/media/markdown/html/code/diff
 * switch.
 */
export function FileContentView({
	viewMode,
	selectedFile,
	selectedChange,
	selectedGitDiff,
	previewMode,
	rawBlobUrl,
	scrollRatio,
	onScrollRatioChange,
	onCopyPrompt,
	onEnablePreview,
	sessionWorkingDir,
	filesApiBase,
	onDownload,
}: FileContentViewProps) {
	if (viewMode === "file" && selectedFile) {
		const path = selectedFile.path;

		if (isImageFile(path)) {
			return (
				<ImageViewer
					content={selectedFile.content}
					mimeType={selectedFile.mimeType}
					fileName={getFileName(path)}
					size={selectedFile.size}
					srcUrl={rawBlobUrl ?? undefined}
				/>
			);
		}

		if (isMediaFile(path)) {
			return <MediaContent file={selectedFile} rawBlobUrl={rawBlobUrl} />;
		}

		if (isModelFile(path)) {
			return (
				<StlViewer
					srcUrl={rawBlobUrl}
					fileName={getFileName(path)}
					size={selectedFile.size}
				/>
			);
		}

		if (previewMode && isMarkdownFile(path)) {
			return (
				<MarkdownViewer
					content={selectedFile.content}
					truncated={selectedFile.truncated}
					initialScrollRatio={scrollRatio}
					onScrollRatioChange={onScrollRatioChange}
					filePath={path}
					sessionWorkingDir={sessionWorkingDir}
					filesApiBase={filesApiBase}
				/>
			);
		}

		if (previewMode && isHtmlFile(path)) {
			return (
				<HtmlViewer content={selectedFile.content} fileName={getFileName(path)} />
			);
		}

		// Non-image binary (PDF/zip/…): the backend returns base64. Don't dump it
		// into the code viewer — offer a download instead.
		if (selectedFile.encoding === "base64") {
			return <BinaryPlaceholder file={selectedFile} onDownload={onDownload} />;
		}

		return (
			<CodeViewer
				onCopyPrompt={onCopyPrompt}
				content={selectedFile.content}
				language={getLanguageFromPath(path)}
				fileName={getFileName(path)}
				filePath={path}
				truncated={selectedFile.truncated}
				showLineNumbers={true}
				hasPreview={isMarkdownFile(path) || isHtmlFile(path)}
				onTogglePreview={onEnablePreview}
				initialScrollRatio={scrollRatio}
				onScrollRatioChange={onScrollRatioChange}
			/>
		);
	}

	if (viewMode === "diff" && selectedChange) {
		return (
			<DiffViewer
				onCopyPrompt={onCopyPrompt}
				oldContent={selectedChange.oldContent}
				newContent={selectedChange.newContent}
				fileName={getFileName(selectedChange.path)}
				toolName={selectedChange.toolName}
			/>
		);
	}

	if (viewMode === "diff" && selectedGitDiff) {
		return (
			<DiffViewer
				onCopyPrompt={onCopyPrompt}
				unifiedDiff={selectedGitDiff.diff}
				fileName={getFileName(selectedGitDiff.path)}
				toolName="git"
			/>
		);
	}

	return null;
}
