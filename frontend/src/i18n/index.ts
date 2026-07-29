import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { IDENTITY } from "../../../shared/identity";
import { storageKey } from "../utils/app-storage";

const resources = {
	en: { translation: en },
	ja: { translation: ja },
};

i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources,
		fallbackLng: "en",
		supportedLngs: ["en", "ja"],
		interpolation: {
			escapeValue: false,
			// Always available to every message, so the catalogs can name the
			// product without hard-coding it (#459) and no call site has to
			// remember to pass it. A message may still override one by passing
			// the same key explicitly.
			defaultVariables: {
				product: IDENTITY.productName,
				bin: IDENTITY.binaryName,
			},
		},
		detection: {
			order: ["localStorage", "navigator", "htmlTag"],
			caches: ["localStorage"],
			lookupLocalStorage: storageKey("language"),
		},
	});
