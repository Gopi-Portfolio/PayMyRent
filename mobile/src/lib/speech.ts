// Speech-to-text is optional. Expo Go (and some devices) don't ship the native module, so we load it
// defensively: when missing, the mic button hides itself and users type instead.
let mod: any = null;
try {
  mod = require('expo-speech-recognition');
} catch {
  mod = null;
}

export const SpeechModule: any = mod?.ExpoSpeechRecognitionModule ?? null;
export const speechAvailable = !!SpeechModule;
export const useSpeechEvent: (name: string, cb: (e: any) => void) => void =
  mod?.useSpeechRecognitionEvent ?? (() => undefined);
