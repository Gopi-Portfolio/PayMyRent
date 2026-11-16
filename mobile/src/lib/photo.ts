// Photos for reading text: scaled to 2000 px on the long side (plenty for text and faces) and sent as a JPEG of about 1 to 2 MB.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export async function shrink(asset: { uri: string; width?: number; height?: number }): Promise<string> {
  const ctx = ImageManipulator.manipulate(asset.uri);
  if ((asset.width ?? 0) >= (asset.height ?? 0)) { if ((asset.width ?? 0) > 2000) ctx.resize({ width: 2000 }); }
  else if ((asset.height ?? 0) > 2000) ctx.resize({ height: 2000 });
  const img = await ctx.renderAsync();
  return (await img.saveAsync({ compress: 0.8, format: SaveFormat.JPEG })).uri;
}
