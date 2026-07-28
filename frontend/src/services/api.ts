import { storageKey } from "../utils/app-storage";
const API_BASE = import.meta.env.VITE_API_URL || "";
const TOKEN_KEY = storageKey("token");

// Get auth token from localStorage
export function getAuthToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

// Check if an error is a transient network error (timeout or connection failure)
export function isTransientNetworkError(err: unknown): boolean {
	// AbortError from fetchWithTimeout
	if (err instanceof DOMException && err.name === "AbortError") return true;
	// TypeError "Failed to fetch" from network/connection failure
	if (err instanceof TypeError && err.message === "Failed to fetch")
		return true;
	return false;
}
// Fetch with timeout using AbortController
export async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs = 10000,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
}

// Authenticated fetch - automatically adds auth header if token exists
export async function authFetch(
	url: string,
	options: RequestInit = {},
	timeoutMs = 10000,
): Promise<Response> {
	const token = getAuthToken();
	const headers = new Headers(options.headers);

	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	return fetchWithTimeout(url, { ...options, headers }, timeoutMs);
}

// Auth API helpers

// Check if authentication is required
export async function isAuthRequired(): Promise<boolean> {
	const res = await fetchWithTimeout(`${API_BASE}/api/auth/required`);
	if (!res.ok) {
		return false;
	}
	const data = await res.json();
	return data.required;
}

// Login with password
export async function login(password: string): Promise<{ token: string }> {
	const res = await fetchWithTimeout(`${API_BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});

	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Login failed" }));
		throw new Error(error.error || "Login failed");
	}

	return res.json();
}

export async function logout(token: string) {
	const res = await fetchWithTimeout(`${API_BASE}/api/auth/logout`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	});

	if (!res.ok) {
		throw new Error("Logout failed");
	}

	return res.json();
}

export async function getMe(token: string) {
	const res = await fetchWithTimeout(`${API_BASE}/api/auth/me`, {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});

	if (!res.ok) {
		throw new Error("Failed to get user info");
	}

	return res.json();
}
