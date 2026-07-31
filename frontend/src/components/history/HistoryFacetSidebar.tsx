import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type FacetData,
	type FacetState,
	type FacetValue,
	type HistoryPeriod,
	toggleFacet,
} from "../../utils/historyFacets";

interface HistoryFacetSidebarProps {
	data: FacetData;
	state: FacetState;
	onChange: (next: FacetState) => void;
}

const VISIBLE_CAP = 6;

function CheckRow({
	checked,
	label,
	count,
	color,
	onToggle,
}: {
	checked: boolean;
	label: string;
	count: number;
	color?: string;
	onToggle: () => void;
}) {
	return (
		<label className="flex items-center justify-between gap-2 py-1 cursor-pointer group">
			<span className="flex items-center gap-2 min-w-0">
				<input
					type="checkbox"
					checked={checked}
					onChange={onToggle}
					className="h-3.5 w-3.5 shrink-0 accent-[var(--color-conv-accent)]"
				/>
				{color && (
					<span
						className="w-1.5 h-1.5 rounded-full shrink-0"
						style={{ backgroundColor: color }}
					/>
				)}
				<span
					className={`truncate text-[12.5px] ${checked ? "text-cv-text" : "text-cv-text-secondary group-hover:text-cv-text"}`}
				>
					{label}
				</span>
			</span>
			<span className="shrink-0 text-[11px] tabular-nums text-cv-text-muted">
				{count}
			</span>
		</label>
	);
}

function MultiGroup({
	title,
	values,
	selected,
	onToggle,
}: {
	title: string;
	values: FacetValue[];
	selected: Set<string>;
	onToggle: (value: string) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	if (values.length === 0) return null;
	const shown = expanded ? values : values.slice(0, VISIBLE_CAP);
	return (
		<div className="mb-4">
			<div className="mb-1 text-[11px] font-medium text-cv-text-muted">
				{title}
			</div>
			{shown.map((v) => (
				<CheckRow
					key={v.value}
					checked={selected.has(v.value)}
					label={v.label}
					count={v.count}
					color={v.color}
					onToggle={() => onToggle(v.value)}
				/>
			))}
			{values.length > VISIBLE_CAP && (
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					className="mt-0.5 text-[11px] text-cv-text-muted hover:text-cv-text"
				>
					{expanded
						? t("common.showLess")
						: t("history.facetMore", { count: values.length - VISIBLE_CAP })}
				</button>
			)}
		</div>
	);
}

/**
 * Faceted filter sidebar (desktop left rail / drawer body). Period is
 * single-select and sits on top: the Project / Agent / Branch / Peer
 * multi-select groups below it are scoped (options and counts) to the
 * selected date range.
 */
export function HistoryFacetSidebar({
	data,
	state,
	onChange,
}: HistoryFacetSidebarProps) {
	const { t } = useTranslation();

	const periods: { value: HistoryPeriod; label: string }[] = [
		{ value: "24h", label: t("history.periodToday") },
		{ value: "7d", label: t("history.period7d") },
		{ value: "30d", label: t("history.period30d") },
		{ value: null, label: t("history.periodAll") },
	];

	return (
		<div className="text-[12.5px]">
			{/* Period first: it scopes the option lists / counts of every group
			    below, so it reads as the outermost filter. */}
			<div className="mb-4">
				<div className="mb-1 text-[11px] font-medium text-cv-text-muted">
					{t("history.facetPeriod")}
				</div>
				{periods.map((p) => (
					<label
						key={p.value ?? "all"}
						className="flex items-center gap-2 py-1 cursor-pointer group"
					>
						<input
							type="radio"
							name="history-period"
							checked={state.period === p.value}
							onChange={() => onChange({ ...state, period: p.value })}
							className="h-3.5 w-3.5 shrink-0 accent-[var(--color-conv-accent)]"
						/>
						<span
							className={`text-[12.5px] ${state.period === p.value ? "text-cv-text" : "text-cv-text-secondary group-hover:text-cv-text"}`}
						>
							{p.label}
						</span>
					</label>
				))}
			</div>
			<MultiGroup
				title={t("history.facetProject")}
				values={data.projects}
				selected={state.projects}
				onToggle={(v) => onChange(toggleFacet(state, "projects", v))}
			/>
			<MultiGroup
				title={t("history.facetAgent")}
				values={data.agents}
				selected={state.agents}
				onToggle={(v) => onChange(toggleFacet(state, "agents", v))}
			/>
			<MultiGroup
				title={t("history.facetBranch")}
				values={data.branches}
				selected={state.branches}
				onToggle={(v) => onChange(toggleFacet(state, "branches", v))}
			/>
			{data.peers.length > 0 && (
				<MultiGroup
					title={t("history.facetPeer")}
					values={data.peers}
					selected={state.peers}
					onToggle={(v) => onChange(toggleFacet(state, "peers", v))}
				/>
			)}
		</div>
	);
}
