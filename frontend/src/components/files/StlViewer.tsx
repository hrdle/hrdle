import { Box, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	mat4Multiply,
	mat4Orthonormalize,
	mat4RotationX,
	mat4RotationY,
} from "../../utils/mat4";
import { parseStl, type StlMesh } from "../../utils/stl-parse";
import {
	createStlScene,
	type StlCamera,
	type StlScene,
	worldPerPixel,
} from "../../utils/stl-render";

interface StlViewerProps {
	/** Same-origin blob: URL for the file, fetched with auth by the caller. */
	srcUrl: string | null;
	fileName: string;
	size?: number;
}

// A CAD STL is Z-up, so the resting view rotates the model back onto its feet
// (-90 degrees) and then tips it forward far enough to see the top face.
const INITIAL_PITCH = -1.15;
const INITIAL_YAW = -0.6;
const RADIANS_PER_PIXEL = 0.01;

function initialOrientation() {
	return mat4Multiply(mat4RotationX(INITIAL_PITCH), mat4RotationY(INITIAL_YAW));
}
const MAX_DEVICE_PIXEL_RATIO = 2;

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatDimension(value: number): string {
	if (value === 0) return "0";
	const abs = Math.abs(value);
	if (abs >= 100) return value.toFixed(0);
	if (abs >= 1) return value.toFixed(1);
	return value.toPrecision(2);
}

export function StlViewer({ srcUrl, fileName, size }: StlViewerProps) {
	const { t } = useTranslation();
	const [mesh, setMesh] = useState<StlMesh | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Bumped to rebuild the scene after the GPU takes the context away.
	const [contextEpoch, setContextEpoch] = useState(0);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const cameraRef = useRef<StlCamera>({
		orientation: initialOrientation(),
		distance: 1,
		panX: 0,
		panY: 0,
	});
	const resetViewRef = useRef<() => void>(() => {});

	useEffect(() => {
		if (!srcUrl) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		setMesh(null);

		(async () => {
			try {
				const response = await fetch(srcUrl);
				const buffer = await response.arrayBuffer();
				if (cancelled) return;
				setMesh(parseStl(buffer));
			} catch (e) {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : String(e));
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [srcUrl]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `contextEpoch` is not read here; its change is the cue to rebuild the lost GL context.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !mesh) return;

		const gl =
			canvas.getContext("webgl", { antialias: true, alpha: true }) ??
			(canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
		if (!gl) {
			setError("webgl-unavailable");
			return;
		}

		let scene: StlScene;
		try {
			scene = createStlScene(gl, mesh);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return;
		}

		const camera = cameraRef.current;
		const resetView = () => {
			camera.orientation = initialOrientation();
			camera.distance = scene.fitDistanceFor(
				canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1,
			);
			camera.panX = 0;
			camera.panY = 0;
			requestDraw();
		};
		resetViewRef.current = resetView;

		let frame = 0;
		const draw = () => {
			frame = 0;
			scene.draw(camera, canvas.width, canvas.height);
		};
		const requestDraw = () => {
			if (frame === 0) frame = requestAnimationFrame(draw);
		};

		const resize = () => {
			const ratio = Math.min(
				window.devicePixelRatio || 1,
				MAX_DEVICE_PIXEL_RATIO,
			);
			const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
			const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
			requestDraw();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resize();

		// Pointer state. Two pointers means pinch-zoom and two-finger pan, which
		// is the only way to pan on a touch screen - there is no second button.
		const pointers = new Map<number, { x: number; y: number }>();
		let pinchDistance = 0;

		const centroid = () => {
			let x = 0;
			let y = 0;
			for (const p of pointers.values()) {
				x += p.x;
				y += p.y;
			}
			return { x: x / pointers.size, y: y / pointers.size };
		};
		const spread = () => {
			const [a, b] = [...pointers.values()];
			if (!a || !b) return 0;
			return Math.hypot(a.x - b.x, a.y - b.y);
		};

		// Turned about the axes of the screen rather than the model's own, so a
		// drag moves the surface under the finger the same way wherever the
		// model has been turned to, and no direction runs out of travel.
		const rotate = (dx: number, dy: number) => {
			const spin = mat4Multiply(
				mat4RotationX(dy * RADIANS_PER_PIXEL),
				mat4RotationY(dx * RADIANS_PER_PIXEL),
			);
			camera.orientation = mat4Orthonormalize(
				mat4Multiply(spin, camera.orientation),
			);
		};

		const pan = (dx: number, dy: number) => {
			const perPixel = worldPerPixel(camera.distance, canvas.clientHeight);
			camera.panX += dx * perPixel;
			camera.panY -= dy * perPixel;
		};

		const clampDistance = (value: number) =>
			Math.min(Math.max(value, scene.radius * 0.05), scene.radius * 200);

		const onPointerDown = (event: PointerEvent) => {
			canvas.setPointerCapture(event.pointerId);
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (pointers.size === 2) pinchDistance = spread();
		};

		const onPointerMove = (event: PointerEvent) => {
			const previous = pointers.get(event.pointerId);
			if (!previous) return;
			const previousCentroid = centroid();
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			const nextCentroid = centroid();
			const dx = nextCentroid.x - previousCentroid.x;
			const dy = nextCentroid.y - previousCentroid.y;

			if (pointers.size >= 2) {
				const nextSpread = spread();
				if (pinchDistance > 0 && nextSpread > 0) {
					camera.distance = clampDistance(
						camera.distance * (pinchDistance / nextSpread),
					);
				}
				pinchDistance = nextSpread;
				pan(dx, dy);
			} else if (event.shiftKey || event.buttons === 2 || event.buttons === 4) {
				pan(dx, dy);
			} else {
				rotate(dx, dy);
			}
			requestDraw();
			event.preventDefault();
		};

		const onPointerUp = (event: PointerEvent) => {
			pointers.delete(event.pointerId);
			pinchDistance = pointers.size === 2 ? spread() : 0;
		};

		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			camera.distance = clampDistance(
				camera.distance * Math.exp(event.deltaY * 0.001),
			);
			requestDraw();
		};

		const onDoubleClick = () => resetView();
		const onContextMenu = (event: MouseEvent) => event.preventDefault();
		const onContextLost = (event: Event) => {
			event.preventDefault();
		};
		const onContextRestored = () => setContextEpoch((n) => n + 1);

		canvas.addEventListener("pointerdown", onPointerDown);
		canvas.addEventListener("pointermove", onPointerMove);
		canvas.addEventListener("pointerup", onPointerUp);
		canvas.addEventListener("pointercancel", onPointerUp);
		canvas.addEventListener("wheel", onWheel, { passive: false });
		canvas.addEventListener("dblclick", onDoubleClick);
		canvas.addEventListener("contextmenu", onContextMenu);
		canvas.addEventListener("webglcontextlost", onContextLost);
		canvas.addEventListener("webglcontextrestored", onContextRestored);

		resetView();

		return () => {
			observer.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", onPointerUp);
			canvas.removeEventListener("pointercancel", onPointerUp);
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("dblclick", onDoubleClick);
			canvas.removeEventListener("contextmenu", onContextMenu);
			canvas.removeEventListener("webglcontextlost", onContextLost);
			canvas.removeEventListener("webglcontextrestored", onContextRestored);
			scene.dispose();
		};
	}, [mesh, contextEpoch]);

	const handleReset = useCallback(() => resetViewRef.current(), []);

	const dimensions = mesh
		? ([0, 1, 2].map((axis) =>
				formatDimension(
					(mesh.max[axis] as number) - (mesh.min[axis] as number),
				),
			) as [string, string, string])
		: null;

	return (
		<div className="flex flex-col h-full bg-th-bg text-th-text">
			<div className="flex items-center gap-2 px-3 py-2 border-b border-th-border bg-th-surface">
				<Box className="w-4 h-4 text-green-400 shrink-0" />
				<span className="text-sm text-th-text-secondary truncate flex-1">
					{fileName}
				</span>
				{mesh && (
					<button
						type="button"
						onClick={handleReset}
						className="p-1.5 hover:bg-th-surface-hover rounded transition-colors"
						title={t("files.stlResetView")}
					>
						<RotateCcw className="w-4 h-4" />
					</button>
				)}
			</div>

			<div className="relative flex-1 min-h-0 bg-th-bg">
				<canvas
					ref={canvasRef}
					className="w-full h-full block touch-none"
					style={{ cursor: "grab" }}
				/>
				{(loading || error || (mesh && mesh.triangleCount === 0)) && (
					<div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-th-text-muted">
						{loading
							? t("files.stlLoading")
							: error === "webgl-unavailable"
								? t("files.stlNoWebgl")
								: error
									? t("files.stlParseFailed")
									: t("files.stlEmpty")}
					</div>
				)}
			</div>

			<div className="px-3 py-1.5 border-t border-th-border text-xs text-th-text-muted flex items-center gap-2">
				<span className="truncate">
					{mesh && t("files.stlTriangles", { count: mesh.triangleCount })}
					{dimensions && ` • ${dimensions.join(" × ")}`}
					{size ? ` • ${formatFileSize(size)}` : ""}
				</span>
				<span className="ml-auto hidden sm:inline shrink-0">
					{t("files.stlHint")}
				</span>
			</div>
		</div>
	);
}
