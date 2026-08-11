import { Lock } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

interface LoginFormProps {
	onLogin: (password: string) => Promise<void>;
	isLoading: boolean;
	error: string | null;
}

export function LoginForm({ onLogin, isLoading, error }: LoginFormProps) {
	const { t } = useTranslation();
	const [password, setPassword] = useState("");

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		try {
			await onLogin(password);
		} catch {
			// Error is handled by parent
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-th-bg">
			<div className="bg-th-surface p-8 rounded-md border border-th-border w-full max-w-sm">
				<div className="flex flex-col items-center gap-3 mb-8">
					<div className="w-10 h-10 rounded-md bg-th-surface-hover flex items-center justify-center">
						<Lock className="w-5 h-5 text-th-text-secondary" />
					</div>
					<h1 className="text-xl font-semibold text-th-text tracking-tight">
						Hrdle
					</h1>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label
							htmlFor="password"
							className="block text-sm font-medium text-th-text-secondary mb-1"
						>
							{t("auth.password")}
						</label>
						<input
							type="password"
							id="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full px-3 py-2 bg-th-surface-hover border border-th-border rounded-md text-th-text placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
							required
							disabled={isLoading}
						/>
					</div>

					{error && (
						<div className="text-red-400 text-sm bg-red-900/20 p-3 rounded-md">
							{error}
						</div>
					)}

					<button
						type="submit"
						disabled={isLoading}
						className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
					>
						{isLoading ? t("auth.authenticating") : t("auth.login")}
					</button>
				</form>
			</div>
		</div>
	);
}
