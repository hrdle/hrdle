import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import { storageKey } from "../utils/app-storage";

interface AuthState {
	token: string | null;
	isLoading: boolean;
	error: string | null;
	authRequired: boolean | null; // null = checking
}

const TOKEN_KEY = storageKey("token");

export function useAuth() {
	const [state, setState] = useState<AuthState>({
		token: null,
		isLoading: true,
		error: null,
		authRequired: null,
	});

	// Check if auth is required and validate existing token
	useEffect(() => {
		const checkAuth = async () => {
			try {
				const required = await api.isAuthRequired();

				if (!required) {
					// No auth required
					setState({
						token: null,
						isLoading: false,
						error: null,
						authRequired: false,
					});
					return;
				}

				// Auth is required, check for existing token
				const token = localStorage.getItem(TOKEN_KEY);
				if (token) {
					try {
						await api.getMe(token);
						setState({
							token,
							isLoading: false,
							error: null,
							authRequired: true,
						});
					} catch {
						// Token invalid
						localStorage.removeItem(TOKEN_KEY);
						setState({
							token: null,
							isLoading: false,
							error: null,
							authRequired: true,
						});
					}
				} else {
					setState({
						token: null,
						isLoading: false,
						error: null,
						authRequired: true,
					});
				}
			} catch {
				// API error, assume no auth required
				setState({
					token: null,
					isLoading: false,
					error: null,
					authRequired: false,
				});
			}
		};

		checkAuth();
	}, []);

	const login = useCallback(async (password: string) => {
		setState((s) => ({ ...s, isLoading: true, error: null }));
		try {
			const data = await api.login(password);
			localStorage.setItem(TOKEN_KEY, data.token);
			setState((s) => ({
				...s,
				token: data.token,
				isLoading: false,
				error: null,
			}));
		} catch (error) {
			setState((s) => ({
				...s,
				isLoading: false,
				error: error instanceof Error ? error.message : "Login failed",
			}));
			throw error;
		}
	}, []);

	const logout = useCallback(async () => {
		const token = state.token;
		if (token) {
			try {
				await api.logout(token);
			} catch {
				// Ignore logout errors
			}
		}
		localStorage.removeItem(TOKEN_KEY);
		setState((s) => ({
			...s,
			token: null,
			error: null,
		}));
	}, [state.token]);

	// Authenticated if: auth not required, or have valid token
	const isAuthenticated = state.authRequired === false || !!state.token;

	return {
		token: state.token,
		isLoading: state.isLoading,
		error: state.error,
		authRequired: state.authRequired,
		isAuthenticated,
		login,
		logout,
	};
}
