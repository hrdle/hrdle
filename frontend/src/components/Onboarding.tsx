/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { storageKey } from "../utils/app-storage";

const ONBOARDING_KEY = storageKey("onboarding-completed");
const ONBOARDING_SESSIONLIST_KEY = storageKey("onboarding-sessionlist-completed");

interface SpotlightStep {
	// CSS selector for the target element
	target: string;
	// Translation keys
	titleKey: string;
	descriptionKey: string;
	// Tooltip position relative to target
	position: "top" | "bottom" | "left" | "right";
	// Action to execute before showing this step (e.g., 'open-keyboard')
	beforeAction?: string;
}

// Main screen steps (terminal view)
const mainSteps: SpotlightStep[] = [
	{
		target: '[data-onboarding="terminal"]',
		titleKey: "onboarding.step1Title",
		descriptionKey: "onboarding.step1Description",
		position: "bottom",
	},
	{
		target: '[data-onboarding="session-list"]',
		titleKey: "onboarding.step2Title",
		descriptionKey: "onboarding.step2Description",
		position: "left",
	},
	{
		target: '[data-onboarding="dashboard"]',
		titleKey: "onboarding.step3Title",
		descriptionKey: "onboarding.step3Description",
		position: "left",
	},
	{
		target: '[data-onboarding="file-browser"]',
		titleKey: "onboarding.step4Title",
		descriptionKey: "onboarding.step4Description",
		position: "bottom",
	},
	{
		target: '[data-onboarding="conversation"]',
		titleKey: "onboarding.step5Title",
		descriptionKey: "onboarding.step5Description",
		position: "bottom",
	},
	{
		target: '[data-onboarding="terminal"]',
		titleKey: "onboarding.step6Title",
		descriptionKey: "onboarding.step6Description",
		position: "bottom",
		beforeAction: "open-keyboard",
	},
	{
		target: '[data-onboarding="reload"]',
		titleKey: "onboarding.step7Title",
		descriptionKey: "onboarding.step7Description",
		position: "bottom",
	},
	{
		target: '[data-onboarding="split-pane"]',
		titleKey: "onboarding.splitPaneTitle",
		descriptionKey: "onboarding.splitPaneDescription",
		position: "bottom",
	},
];

// Session list screen steps
const sessionListSteps: SpotlightStep[] = [
	{
		target: '[data-onboarding="session-item"]',
		titleKey: "onboarding.sessionItemTitle",
		descriptionKey: "onboarding.sessionItemDescription",
		position: "left",
	},
	{
		target: '[data-onboarding="new-session"]',
		titleKey: "onboarding.newSessionTitle",
		descriptionKey: "onboarding.newSessionDescription",
		position: "left",
	},
	{
		target: '[data-onboarding="history-tab"]',
		titleKey: "onboarding.historyTabTitle",
		descriptionKey: "onboarding.historyTabDescription",
		position: "left",
	},
	{
		target: '[data-onboarding="dashboard-tab"]',
		titleKey: "onboarding.dashboardTabTitle",
		descriptionKey: "onboarding.dashboardTabDescription",
		position: "left",
	},
];

interface SpotlightRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

type OnboardingType = "main" | "sessionList";

interface OnboardingProps {
	onComplete: () => void;
	type?: OnboardingType;
	onStepAction?: (action: string) => void;
}

export function Onboarding({
	onComplete,
	type = "main",
	onStepAction,
}: OnboardingProps) {
	const { t } = useTranslation();
	const [currentStep, setCurrentStep] = useState(0);
	const [targetRect, setTargetRect] = useState<SpotlightRect | null>(null);
	const [isReady, setIsReady] = useState(false);

	// Get steps based on type
	const stepsForType = type === "sessionList" ? sessionListSteps : mainSteps;

	// Filter steps to only include those with existing target elements
	const [availableSteps, setAvailableSteps] = useState<SpotlightStep[]>([]);

	useEffect(() => {
		// Reset state when type changes
		setCurrentStep(0);
		setAvailableSteps([]);
		setIsReady(false);
		setTargetRect(null);

		// Retry until we find at least one element (for loading screens)
		let retryCount = 0;
		const maxRetries = 20; // 20 * 200ms = 4 seconds max
		let cancelled = false;

		const tryFindElements = () => {
			if (cancelled) return;

			const filtered = stepsForType.filter((s) => {
				const found = document.querySelector(s.target) !== null;
				return found || (s.beforeAction != null && onStepAction != null);
			});
			if (filtered.length > 0) {
				if (!cancelled) {
					setAvailableSteps(filtered);
				}
			} else if (retryCount >= maxRetries) {
				// No elements found after max retries - auto-complete onboarding
				if (!cancelled) {
					onComplete();
				}
			} else {
				retryCount++;
				setTimeout(tryFindElements, 200);
			}
		};

		// Initial delay then start trying
		const timer = setTimeout(tryFindElements, 200);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [stepsForType, onStepAction, onComplete]);

	const step = availableSteps[currentStep];
	const isLastStep = currentStep === availableSteps.length - 1;

	// Save completion and cleanup
	const handleComplete = useCallback(() => {
		onStepAction?.("cleanup");
		const key =
			type === "sessionList" ? ONBOARDING_SESSIONLIST_KEY : ONBOARDING_KEY;
		localStorage.setItem(key, "true");
		onComplete();
	}, [onStepAction, type, onComplete]);

	// Find and measure the target element (for resize)
	const updateTargetRect = useCallback(() => {
		if (!step) return;
		const element = document.querySelector(step.target);
		if (element) {
			const rect = element.getBoundingClientRect();
			setTargetRect({
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
			});
			setIsReady(true);
		}
	}, [step]);

	// Find target on step change (with beforeAction support for keyboard etc.)
	useEffect(() => {
		setIsReady(false);
		setTargetRect(null); // Clear old target to show loading during transition
		if (!step) return;

		let cancelled = false;
		let actionTriggered = false;
		let retries = 0;
		const maxRetries = 10;

		const tryFind = () => {
			if (cancelled) return;

			// Execute beforeAction first (e.g., open keyboard) before looking for target
			if (step.beforeAction && onStepAction && !actionTriggered) {
				onStepAction(step.beforeAction);
				actionTriggered = true;
				setTimeout(tryFind, 200);
				return;
			}

			const element = document.querySelector(step.target);
			if (element) {
				const rect = element.getBoundingClientRect();
				setTargetRect({
					top: rect.top,
					left: rect.left,
					width: rect.width,
					height: rect.height,
				});
				setIsReady(true);
				return;
			}

			retries++;
			if (retries < maxRetries) {
				setTimeout(tryFind, 200);
			} else {
				// Skip this step
				if (!cancelled) {
					setCurrentStep((prev) => prev + 1);
				}
			}
		};

		const timer = setTimeout(tryFind, 100);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [step, onStepAction]);

	// Handle step overflow (skipped past last step)
	useEffect(() => {
		if (availableSteps.length > 0 && currentStep >= availableSteps.length) {
			handleComplete();
		}
	}, [currentStep, availableSteps.length, handleComplete]);

	// Update position on window resize
	useEffect(() => {
		window.addEventListener("resize", updateTargetRect);
		return () => window.removeEventListener("resize", updateTargetRect);
	}, [updateTargetRect]);

	const handleNext = () => {
		if (currentStep < availableSteps.length - 1) {
			setCurrentStep(currentStep + 1);
		} else {
			handleComplete();
		}
	};

	const handleSkip = () => {
		handleComplete();
	};

	// Calculate tooltip position
	const getTooltipStyle = (): React.CSSProperties => {
		if (!targetRect) return { opacity: 0 };

		const padding = 16;
		const bottomPadding = 48; // Extra padding for mobile navigation bar
		const tooltipWidth = 280;
		const tooltipHeight = 180; // Approximate
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.visualViewport?.height || window.innerHeight;

		// On mobile (narrow screens) or large targets, always center the tooltip
		const isMobile = viewportWidth < 640;
		const targetArea = targetRect.width * targetRect.height;
		const viewportArea = viewportWidth * viewportHeight;
		const isLargeTarget = targetArea > viewportArea * 0.5;

		let top = 0;
		let left = 0;

		if (isMobile || isLargeTarget) {
			// Center tooltip in viewport
			top = (viewportHeight - tooltipHeight) / 2;
			left = (viewportWidth - tooltipWidth) / 2;
		} else {
			switch (step.position) {
				case "top":
					top = targetRect.top - tooltipHeight - padding;
					left = targetRect.left + (targetRect.width - tooltipWidth) / 2;
					break;
				case "bottom":
					top = targetRect.top + targetRect.height + padding;
					left = targetRect.left + (targetRect.width - tooltipWidth) / 2;
					break;
				case "left":
					top = targetRect.top + (targetRect.height - tooltipHeight) / 2;
					left = targetRect.left - tooltipWidth - padding;
					break;
				case "right":
					top = targetRect.top + (targetRect.height - tooltipHeight) / 2;
					left = targetRect.left + targetRect.width + padding;
					break;
			}

			// For keyboard steps, position tooltip in upper area to avoid keyboard overlap
			if (step.beforeAction === "open-keyboard") {
				top = padding * 2;
				left = (viewportWidth - tooltipWidth) / 2;
			}

			// Keep tooltip within viewport
			if (left < padding) left = padding;
			if (left + tooltipWidth > viewportWidth - padding) {
				left = viewportWidth - tooltipWidth - padding;
			}
			if (top < padding) top = padding;
			if (top + tooltipHeight > viewportHeight - bottomPadding) {
				top = viewportHeight - tooltipHeight - bottomPadding;
			}
		}

		return {
			position: "fixed",
			top: `${top}px`,
			left: `${left}px`,
			width: `${tooltipWidth}px`,
			zIndex: 10001,
			opacity: isReady ? 1 : 0,
			transition: "opacity 0.2s ease-in-out",
		};
	};

	// Wait for steps to be filtered and ready
	if (availableSteps.length === 0 || !step) {
		// Show loading state briefly
		return (
			<div className="fixed inset-0 bg-[var(--color-overlay)] z-[10000] flex items-center justify-center">
				<div className="text-th-text">{t("common.loading")}</div>
			</div>
		);
	}

	if (!isReady && !targetRect) {
		// Show loading state briefly
		return (
			<div className="fixed inset-0 bg-[var(--color-overlay)] z-[10000] flex items-center justify-center">
				<div className="text-th-text">{t("common.loading")}</div>
			</div>
		);
	}

	return (
		<>
			{/* Overlay with spotlight hole */}
			<div
				className="fixed inset-0 z-[10000] pointer-events-auto"
				onClick={handleNext}
			>
				<svg
					aria-hidden="true"
					width="100%"
					height="100%"
					className="absolute inset-0"
				>
					<defs>
						<mask id="spotlight-mask">
							<rect width="100%" height="100%" fill="white" />
							{targetRect && (
								<rect
									x={targetRect.left - 4}
									y={targetRect.top - 4}
									width={targetRect.width + 8}
									height={targetRect.height + 8}
									rx="8"
									fill="black"
								/>
							)}
						</mask>
					</defs>
					<rect
						width="100%"
						height="100%"
						fill="rgba(0, 0, 0, 0.75)"
						mask="url(#spotlight-mask)"
					/>
				</svg>

				{/* Highlight border around target */}
				{targetRect && (
					<div
						className="absolute border-2 border-blue-400 rounded-md pointer-events-none animate-pulse"
						style={{
							top: targetRect.top - 4,
							left: targetRect.left - 4,
							width: targetRect.width + 8,
							height: targetRect.height + 8,
						}}
					/>
				)}
			</div>

			{/* Tooltip */}
			<div
				style={getTooltipStyle()}
				className="bg-th-surface rounded-xl shadow-2xl overflow-hidden pointer-events-auto"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Progress indicator */}
				<div className="flex gap-1 p-3 justify-center bg-th-bg/50">
					{availableSteps.map((_, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: progress dots; one per step in fixed order
							key={index}
							className={`h-1 rounded-full transition-all ${
								index === currentStep
									? "w-6 bg-blue-500"
									: index < currentStep
										? "w-2 bg-blue-400"
										: "w-2 bg-th-surface-active"
							}`}
						/>
					))}
				</div>

				{/* Content */}
				<div className="px-4 py-3">
					<h2 className="text-lg font-bold text-th-text mb-2">
						{t(step.titleKey)}
					</h2>
					<p className="text-th-text-secondary text-sm leading-relaxed">
						{t(step.descriptionKey)}
					</p>
				</div>

				{/* Actions */}
				<div className="flex gap-2 p-3 border-t border-th-border">
					<button
						type="button"
						onClick={handleSkip}
						className="flex-1 py-2 text-sm text-th-text-secondary hover:text-th-text transition-colors"
					>
						{t("onboarding.skip")}
					</button>
					<button
						type="button"
						onClick={handleNext}
						className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-th-text rounded-md text-sm font-medium transition-colors"
					>
						{isLastStep ? t("onboarding.start") : t("onboarding.next")}
					</button>
				</div>
			</div>
		</>
	);
}

export function useOnboarding() {
	// Check localStorage synchronously to avoid flash
	// ?skipOnboarding=true query parameter skips onboarding (for automated testing)
	const skipParam =
		new URLSearchParams(window.location.search).get("skipOnboarding") ===
		"true";

	const [showOnboarding, setShowOnboarding] = useState(() => {
		if (skipParam) return false;
		const completed = localStorage.getItem(ONBOARDING_KEY);
		return !completed;
	});

	const [showSessionListOnboarding, setShowSessionListOnboarding] = useState(
		() => {
			if (skipParam) return false;
			const completed = localStorage.getItem(ONBOARDING_SESSIONLIST_KEY);
			return !completed;
		},
	);

	const completeOnboarding = useCallback(() => {
		setShowOnboarding(false);
	}, []);

	const completeSessionListOnboarding = useCallback(() => {
		setShowSessionListOnboarding(false);
	}, []);

	const resetOnboarding = useCallback(() => {
		localStorage.removeItem(ONBOARDING_KEY);
		localStorage.removeItem(ONBOARDING_SESSIONLIST_KEY);
		setShowOnboarding(true);
		setShowSessionListOnboarding(true);
	}, []);

	return {
		showOnboarding,
		completeOnboarding,
		showSessionListOnboarding,
		completeSessionListOnboarding,
		resetOnboarding,
	};
}
