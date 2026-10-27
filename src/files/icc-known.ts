/**
 * Known, widely distributed ICC profiles, keyed by the SHA-256 of their
 * canonical bytes: the profile's declared size, with the header creation date
 * (bytes 24..35) and profile ID (bytes 84..99) set to zero.
 *
 * Only hashes are stored here, never profile bytes. Every hash was computed
 * from real profile bytes on the machine named in `source` (see
 * test/unit/privacy-icc.test.ts, which re-derives the Apple entries when those
 * files exist). A profile whose canonical hash is not in this list is treated
 * as unknown, whatever its description says.
 *
 * Not yet covered (needs real sample bytes, not names): profiles embedded by
 * phone cameras (if they differ from the system copies), skia/Chrome and
 * Android built-in profiles, the "Compact ICC" profiles. Until added, images
 * carrying them report ICC findings and need an explicit decision.
 */
export interface KnownIcc {
  name: string;
  size: number;
  source: string;
}

export const KNOWN_ICC: Record<string, KnownIcc> = {
  '6b291ddec7553ff4c7649bbeab8350d4f15bcc7ecf6b90947aba3cc8325cf445': { name: 'sRGB IEC61966-2.1 (HP/Lino, 3144 bytes)', size: 3144, source: 'macOS 26 /System/Library/ColorSync/Profiles/sRGB Profile.icc' },
  '462e5966b1b8f5dd54368e6bbfa3e0e0be8fe58fa24f6cd153bd19b1527178b6': { name: 'Display P3 (Apple)', size: 536, source: 'macOS 26 /System/Library/ColorSync/Profiles/Display P3.icc' },
  '7300f9ea38325c22b846d2645ca45780346051bd5e2d6bdb802c569f22bf0acc': { name: 'Adobe RGB (1998)', size: 560, source: 'macOS 26 /System/Library/ColorSync/Profiles/AdobeRGB1998.icc' },
  '949caed77110d01bb47b3cd652d5fede94381bd5cfee79443771a79cac881f6e': { name: 'ACEScg Linear (Apple)', size: 600, source: 'macOS 26 /System/Library/ColorSync/Profiles/ACESCG Linear.icc' },
  'b814c9e5c0be25c619d630cf19caad4993282eb37586c614802e18cbe111e43b': { name: 'DCI(P3) RGB (Apple)', size: 556, source: 'macOS 26 /System/Library/ColorSync/Profiles/DCI(P3) RGB.icc' },
  '9d599c91d4ba1f96360cc065e93c9f9649b23dacf244ee38139ae147bf49f89b': { name: 'Generic CMYK Profile (Apple)', size: 55280, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic CMYK Profile.icc' },
  'ed9712b6fee07b01f0c34bc9cde58dc32ef03c7d672c37ce1ca11ab46519f1bc': { name: 'Generic Gray Gamma 2.2 Profile (Apple)', size: 4508, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic Gray Gamma 2.2 Profile.icc' },
  'a7a6f228d6b556731752f9d0d05f1b03dfdbe8cc383c6622ed03e6a608db3f80': { name: 'Generic Gray Profile (Apple)', size: 2020, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic Gray Profile.icc' },
  '6e2314fcbd6acae6d385699cb68037f731b73dd5e4a682fd017d9cac13086630': { name: 'Generic Lab Profile (Apple)', size: 3588, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic Lab Profile.icc' },
  '561458ad8af1b30bdb79c4384f27248a424214906ac5791914c90fb91e5c82f7': { name: 'Generic RGB Profile (Apple)', size: 1992, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic RGB Profile.icc' },
  '4922d81c610417508b68cbf167624e623244f7e85098e15837c5a2410ee762a8': { name: 'Generic XYZ Profile (Apple)', size: 1936, source: 'macOS 26 /System/Library/ColorSync/Profiles/Generic XYZ Profile.icc' },
  '9dbe0da0a9f6df2b3e1e04e1998190cb58ae2f7cc48b08dc9a6161c0805590e6': { name: 'ITU-R BT.2020 (Apple)', size: 556, source: 'macOS 26 /System/Library/ColorSync/Profiles/ITU-2020.icc' },
  'fb8ad747c00efde292bdf4250f0664ea42eb141cce084e66a01e792f7cf769f6': { name: 'ITU-R BT.709 (Apple)', size: 556, source: 'macOS 26 /System/Library/ColorSync/Profiles/ITU-709.icc' },
  'abefe6c85285083277b850af6e31b1451be9a61f79b907fe3536d0a87e5dafb6': { name: 'ROMM RGB (Apple)', size: 568, source: 'macOS 26 /System/Library/ColorSync/Profiles/ROMM RGB.icc' },
  'f05e871ae8d9f56127c6d4c5af6e77b7a2980e1fce8c2155188a813b71e323df': { name: 'sRGB built-in (Little CMS 2.17)', size: 588, source: 'cmsCreate_sRGBProfile via Pillow 11.3 / lcms 2.17 on this machine' },
};
