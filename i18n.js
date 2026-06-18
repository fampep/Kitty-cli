import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, 'locales');

let currentLanguage = 'en';
let translations = {};

export function loadLanguage(lang) {
    try {
        const langFile = path.join(LOCALES_DIR, `${lang}.json`);
        if (!fs.existsSync(langFile)) {
            console.warn(`Language file not found for ${lang}, falling back to en`);
            lang = 'en';
        }
        translations = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
        currentLanguage = lang;
        return true;
    } catch (e) {
        console.error(`Error loading language ${lang}:`, e.message);
        if (lang !== 'en') {
            return loadLanguage('en');
        }
        return false;
    }
}

export function getLanguage() {
    return currentLanguage;
}

export function setLanguage(lang) {
    return loadLanguage(lang);
}

export function t(key, replacements = {}) {
    const keys = key.split('.');
    let value = translations;

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            console.warn(`Translation key not found: ${key}`);
            return key;
        }
    }

    if (typeof value !== 'string') {
        console.warn(`Translation value is not a string: ${key}`);
        return key;
    }

    let result = value;
    for (const [placeholder, replacement] of Object.entries(replacements)) {
        result = result.replace(`{{${placeholder}}}`, String(replacement));
    }

    return result;
}

export function getAvailableLanguages() {
    try {
        const files = fs.readdirSync(LOCALES_DIR);
        return files
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''))
            .sort();
    } catch (e) {
        console.error('Error reading available languages:', e.message);
        return ['en'];
    }
}

export function getLanguageNames() {
    const names = {
        'en': 'English',
        'da': 'Dansk (Danish)',
        'es': 'Español (Spanish)',
        'fr': 'Français (French)',
        'de': 'Deutsch (German)',
        'it': 'Italiano (Italian)',
        'pt': 'Português (Portuguese)',
        'ru': 'Русский (Russian)',
        'ja': '日本語 (Japanese)',
        'ko': '한국어 (Korean)',
        'zh': '中文 (Chinese)',
        'ar': 'العربية (Arabic)'
    };
    return names;
}

export function getLanguageName(lang) {
    const names = getLanguageNames();
    return names[lang] || lang;
}

export default {
    loadLanguage,
    getLanguage,
    setLanguage,
    t,
    getAvailableLanguages,
    getLanguageNames,
    getLanguageName
};
