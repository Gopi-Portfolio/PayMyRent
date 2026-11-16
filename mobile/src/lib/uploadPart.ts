// A file for FormData. Expo's fetch (the app's fetch since SDK 52) does not accept React Native's old { uri, name, type } objects
// ("Unsupported FormDataPart implementation"); it takes a Blob. expo-file-system's File is one, read from the file's uri when sent.
import { File } from 'expo-file-system';

export function uploadPart(uri: string): Blob {
  return new File(uri) as unknown as Blob;
}
