/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type SessionResponse, type SessionTheme } from "../../../../shared/types";

// Theme color mapping
const THEME_COLORS: Record<SessionTheme, { border: string; bg: string }> = {
	red: { border: "border-red-500", bg: "bg-red-500" },
	orange: { border: "border-orange-500", bg: "bg-orange-500" },
	amber: { border: "border-amber-500", bg: "bg-amber-500" },
	green: { border: "border-green-500", bg: "bg-green-500" },
	teal: { border: "border-teal-500", bg: "bg-teal-500" },
	blue: { border: "border-blue-500", bg: "bg-blue-500" },
	indigo: { border: "border-indigo-500", bg: "bg-indigo-500" },
	purple: { border: "border-purple-500", bg: "bg-purple-500" },
	pink: { border: "border-pink-500", bg: "bg-pink-500" },
};

const THEME_OPTIONS: (SessionTheme | null)[] = [
	null,
	"red",
	"orange",
	"amber",
	"green",
	"teal",
	"blue",
	"indigo",
	"purple",
	"pink",
];


// Session menu dialog (color change + title edit + delete)
export function SessionMenuDialog({
	session,
	onChangeTheme,
	onChangeTitle,
	onChangeSttPrompt,
	onCreateTab,
	onDelete,
	onCancel,
}: {
	session: SessionResponse;
	onChangeTheme: (theme: SessionTheme | null) => void;
	onChangeTitle?: (title: string) => void;
	onChangeSttPrompt?: (prompt: string | null) => void;
	onCreateTab?: () => void;
	onDelete: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	// The workspace label is the name; customTitle only appears from peers on
	// older versions that still store one.
	const currentName = session.customTitle || session.name;
	const [titleValue, setTitleValue] = useState(currentName);
	const [sttPromptValue, setSttPromptValue] = useState(session.sttPrompt || "");

	if (showDeleteConfirm) {
		return (
			<div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in">
				<div className="bg-th-surface rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl animate-modal-in">
					<h3 className="text-lg font-bold text-th-text mb-2">
						{t("session.deleteSession")}
					</h3>
					<p className="text-th-text-secondary mb-4">
						{t("session.deleteConfirm", { name: session.name })}
					</p>
					<p className="text-sm text-th-text-secondary mb-6">
						{t("session.deleteWarning")}
					</p>
					<div className="flex gap-3 justify-end">
						<button
							type="button"
							onClick={() => setShowDeleteConfirm(false)}
							className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-active rounded font-medium transition-colors"
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							onClick={onDelete}
							className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium transition-colors"
						>
							{t("common.delete")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	const getThemeLabel = (theme: SessionTheme | null) => {
		if (theme === null) return t("common.none");
		return t(`theme.${theme}`);
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-backdrop-in"
			onClick={onCancel}
		>
			<div
				className="bg-th-surface rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl animate-modal-in"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-lg font-bold text-th-text mb-3">{session.name}</h3>

				{/* Color picker */}
				<div className="mb-4">
					<p className="text-sm text-th-text-secondary mb-2">
						{t("session.colorTheme")}
					</p>
					<div className="flex flex-wrap gap-2">
						{THEME_OPTIONS.map((theme) => (
							<button
								type="button"
								key={theme ?? "none"}
								onClick={() => onChangeTheme(theme)}
								className={`w-8 h-8 rounded-full border-2 transition-all ${
									theme === null
										? "bg-th-surface-active border-gray-500"
										: `${THEME_COLORS[theme].bg} border-transparent`
								} ${
									session.theme === theme ||
									(session.theme === undefined && theme === null)
										? "ring-2 ring-white ring-offset-2 ring-offset-gray-800"
										: "hover:scale-110"
								}`}
								title={getThemeLabel(theme)}
							/>
						))}
					</div>
				</div>

				{/* Name edit — writes through to the herdr workspace label */}
				{onChangeTitle && (
					<div className="mb-4">
						<p className="text-sm text-th-text-secondary mb-2">
							{t("session.workspaceName")}
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								value={titleValue}
								onChange={(e) => setTitleValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && titleValue.trim()) {
										onChangeTitle(titleValue.trim());
									}
								}}
								placeholder={t("session.workspaceNamePlaceholder")}
								className="flex-1 bg-th-bg border border-th-border rounded px-2 py-1 text-sm text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500"
							/>
							<button
								type="button"
								disabled={!titleValue.trim()}
								onClick={() => {
									if (titleValue.trim()) onChangeTitle(titleValue.trim());
								}}
								className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
					</div>
				)}

				{/* Speech-to-text vocabulary. This session's own words lead the bias
				    sent with its transcriptions; the shared glossary follows, so a
				    short list is worth more than a long one. */}
				{onChangeSttPrompt && (
					<div className="mb-4">
						<p className="text-sm text-th-text-secondary mb-2">
							{t("session.sttPrompt")}
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								value={sttPromptValue}
								onChange={(e) => setSttPromptValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										onChangeSttPrompt(sttPromptValue.trim() || null);
									}
								}}
								placeholder={t("session.sttPromptPlaceholder")}
								maxLength={100}
								className="flex-1 bg-th-bg border border-th-border rounded px-2 py-1 text-sm text-th-text placeholder-th-text-muted focus:outline-none focus:border-blue-500"
							/>
							<button
								type="button"
								onClick={() => onChangeSttPrompt(sttPromptValue.trim() || null)}
								className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
							>
								{t("common.save")}
							</button>
						</div>
						<p className="mt-1 text-[11px] text-th-text-muted">
							{t("session.sttPromptHint")}
						</p>
					</div>
				)}

				{/* New tab — always available so a single-tab workspace can grow one */}
				{onCreateTab && (
					<div className="mb-4">
						<button
							type="button"
							onClick={onCreateTab}
							className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-th-surface-active hover:bg-white/[0.08] text-th-text text-sm font-medium transition-colors"
						>
							<Plus className="w-4 h-4" />
							{t("session.newTab")}
						</button>
					</div>
				)}

				{/* Actions */}
				<div className="flex gap-3 justify-between pt-3 border-t border-th-border">
					<button
						type="button"
						onClick={() => setShowDeleteConfirm(true)}
						className="px-4 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-400 rounded font-medium transition-colors"
					>
						{t("common.delete")}
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-th-surface-active hover:bg-th-surface-active rounded font-medium transition-colors"
					>
						{t("common.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
