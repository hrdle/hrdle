import { storageKey } from "./app-storage";
const LOG_ENDPOINT = "/api/logs";
// Same key as useAuth — imported by value to avoid pulling React hooks in here.
const TOKEN_KEY = storageKey("token");

type LogLevel = "log" | "warn" | "error" | "info";

interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
	stack?: string;
}

const originalConsole = {
	log: console.log.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	info: console.info.bind(console),
};

// Token value that last got a 401 (null = no token). While the stored token
// still equals it, sending is pointless — stay quiet instead of emitting a
// doomed request per console call.
let unauthorizedToken: string | null | undefined;

function sendLog(entry: LogEntry) {
	const token = localStorage.getItem(TOKEN_KEY);
	if (unauthorizedToken !== undefined && unauthorizedToken === token) return;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	fetch(LOG_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(entry),
	})
		.then((res) => {
			unauthorizedToken = res.status === 401 ? token : undefined;
		})
		.catch(() => {
			// Ignore send errors
		});
}

function formatArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (arg instanceof Error) {
				return `${arg.message}\n${arg.stack}`;
			}
			if (typeof arg === "object") {
				try {
					return JSON.stringify(arg);
				} catch {
					return String(arg);
				}
			}
			return String(arg);
		})
		.join(" ");
}

function createLogger(level: LogLevel) {
	return (...args: unknown[]) => {
		originalConsole[level](...args);

		const message = formatArgs(args);
		const entry: LogEntry = {
			level,
			message,
			timestamp: new Date().toISOString(),
		};

		if (args[0] instanceof Error) {
			entry.stack = (args[0] as Error).stack;
		}

		sendLog(entry);
	};
}

export function initRemoteLogger() {
	console.log = createLogger("log");
	console.warn = createLogger("warn");
	console.error = createLogger("error");
	console.info = createLogger("info");

	// Catch unhandled errors
	window.onerror = (message, source, lineno, colno, error) => {
		sendLog({
			level: "error",
			message: `Unhandled: ${message} at ${source}:${lineno}:${colno}`,
			timestamp: new Date().toISOString(),
			stack: error?.stack,
		});
	};

	// Catch unhandled promise rejections
	window.onunhandledrejection = (event) => {
		sendLog({
			level: "error",
			message: `Unhandled Promise: ${event.reason}`,
			timestamp: new Date().toISOString(),
			stack: event.reason?.stack,
		});
	};

	originalConsole.log("Remote logger initialized");
}
