# KittyCLI Translations / i18n

Multi-language support for KittyCLI with Danish (dansk), English, Spanish, and more.

## Supported Languages

- **en** - English (default)
- **da** - Dansk (Danish)
- **es** - Español (Spanish)
- **fr** - Français (French) 
- **de** - Deutsch (German)
- **it** - Italiano (Italian)
- **pt** - Português (Portuguese)
- **ru** - Русский (Russian)
- **ja** - 日本語 (Japanese)
- **ko** - 한국어 (Korean)
- **zh** - 中文 (Chinese)
- **ar** - العربية (Arabic)

## File Structure

```
locales/
├── en.json          # English (base language)
├── da.json          # Danish
├── es.json          # Spanish
├── fr.json          # French (to be added)
├── de.json          # German (to be added)
├── README.md        # This file
```

## Usage

### In Code

```javascript
import { t, loadLanguage, setLanguage } from './i18n.js';

// Load Danish translations
loadLanguage('da');

// Use translations
console.log(t('app.title'));                    // "KittyCLI"
console.log(t('search.searching', { count: 5 })); // "Søger blandt 5 udbydere..."

// Switch language
setLanguage('en');
```

### Translation Keys

Keys are organized by feature:

- `app.*` - General app messages
- `search.*` - Search interface
- `streaming.*` - Streaming/playback
- `episodes.*` - Episode selection
- `audio.*` - Audio type selection
- `download.*` - Download functionality
- `binge.*` - Binge mode
- `settings.*` - Settings
- `errors.*` - Error messages
- `messages.*` - Info messages

### Using Replacements

Use `{{placeholder}}` syntax for dynamic values:

```javascript
t('streaming.fetchingStreams', { count: 3 })
// Output: "Henter fra 3 udbyder..." (Danish)
```

## Adding a New Language

1. Copy `en.json` to create a new language file (e.g., `fr.json` for French)
2. Translate all values while keeping the key structure identical
3. Update the language name in `getLanguageNames()` in `i18n.js`
4. Update this README with the new language

### Translation Template

```json
{
  "app": {
    "title": "KittyCLI",
    "loading": "[Translate this]",
    ...
  },
  "search": {
    ...
  }
}
```

## Pluralization

For plural forms, use `{{plural}}` placeholder:

```json
"searching": "Søger blandt {{count}} udbyder{{plural}}..."
```

In code:
```javascript
const plural = count !== 1 ? 'e' : '';  // Danish: 'er' vs ''
t('search.searching', { count: 5, plural: 'e' });
```

## API Reference

### `loadLanguage(lang: string): boolean`
Load a language file. Falls back to English if not found.

### `getLanguage(): string`
Get currently loaded language code.

### `setLanguage(lang: string): boolean`
Switch to a different language.

### `t(key: string, replacements: object): string`
Get translated string with optional placeholders.

### `getAvailableLanguages(): string[]`
Get array of available language codes.

### `getLanguageNames(): object`
Get mapping of language codes to display names.

### `getLanguageName(lang: string): string`
Get display name for a specific language.

## Language Codes

Uses ISO 639-1 two-letter codes:
- `en` - English
- `da` - Danish
- `es` - Spanish
- `fr` - French
- `de` - German
- `it` - Italian
- `pt` - Portuguese
- `ru` - Russian
- `ja` - Japanese
- `ko` - Korean
- `zh` - Chinese
- `ar` - Arabic

## Contributing Translations

To contribute a translation:

1. Create a new JSON file with the language code (e.g., `fr.json`)
2. Translate all strings from `en.json`
3. Keep the key structure identical
4. Test with `loadLanguage('xx')`
5. Submit as a pull request

## Settings Integration

Users can set their preferred language in `~/.kittycli/settings.json`:

```json
{
  "language": "da",
  "otherSettings": "..."
}
```

Then load on startup:
```javascript
const settings = loadSettings();
if (settings.language) {
  loadLanguage(settings.language);
}
```
