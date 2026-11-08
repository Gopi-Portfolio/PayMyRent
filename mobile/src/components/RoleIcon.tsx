// Face icons for the role bar. The same person in both roles, told apart at a glance: the OWNER wears teal with a teal ring and a house badge,
// the RENTER wears blue with a blue ring and a key badge. Until "I Am" is chosen the owner shows a woman and a man together.
import React from 'react';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, Rect } from 'react-native-svg';

const SKIN = '#E3A877', HAIR = '#1F1A17', MOUTH = '#8E3B2E';
const OWNER = '#0B6E5F', RENTER = '#2563EB';     // the two roles' colours

function Eyes({ y }: { y: number }) {
  return (
    <>
      <Ellipse cx="16.3" cy={y} rx="1.5" ry="1.8" fill={HAIR} /><Ellipse cx="23.7" cy={y} rx="1.5" ry="1.8" fill={HAIR} />
      <Circle cx="16.8" cy={y - 0.6} r="0.5" fill="#fff" /><Circle cx="24.2" cy={y - 0.6} r="0.5" fill="#fff" />
    </>
  );
}
const Blush = ({ y }: { y: number }) => (
  <>
    <Ellipse cx="13.6" cy={y} rx="2" ry="1.2" fill="#F08A7B" opacity={0.55} /><Ellipse cx="26.4" cy={y} rx="2" ry="1.2" fill="#F08A7B" opacity={0.55} />
  </>
);
const Smile = ({ y }: { y: number }) => <Path d={`M16.6 ${y}Q20 ${y + 3.6} 23.4 ${y}Q20 ${y + 1.4} 16.6 ${y}Z`} fill={MOUTH} />;
const Brows = ({ y }: { y: number }) => (
  <Path d={`M13.6 ${y}Q16 ${y - 1.4} 18.4 ${y}M21.6 ${y}Q24 ${y - 1.4} 26.4 ${y}`} stroke={HAIR} strokeWidth="1" fill="none" strokeLinecap="round" />
);

function ManBody({ shirt = '#0B6E5F' }: { shirt?: string }) {
  return (
    <>
      <Path d="M5 40Q5 28.5 20 28.5Q35 28.5 35 40Z" fill={shirt} />
      <Path d="M16 28.5L20 33L24 28.5Z" fill="#fff" />
      <Rect x="17.6" y="24" width="4.8" height="6" rx="2" fill={SKIN} />
      <Ellipse cx="11.8" cy="19" rx="1.6" ry="2.4" fill={SKIN} /><Ellipse cx="28.2" cy="19" rx="1.6" ry="2.4" fill={SKIN} />
      <Ellipse cx="20" cy="18.5" rx="8.4" ry="9" fill={SKIN} />
      <Path d="M11.4 17.5Q9.6 6.5 20 6.8Q31 6.6 28.6 17.5Q27.5 12.6 22 12Q16 11.2 11.4 17.5Z" fill={HAIR} />
      <Brows y={14.6} /><Eyes y={18} /><Blush y={21.4} /><Smile y={22.2} />
    </>
  );
}

function WomanBody({ shirt = '#E0457B' }: { shirt?: string }) {
  return (
    <>
      <Path d="M9.5 19Q8.5 5.5 20 5.8Q31.5 5.5 30.5 19Q31.5 31 27 33L13 33Q8.5 31 9.5 19Z" fill={HAIR} />
      <Path d="M5 40Q5 29 20 29Q35 29 35 40Z" fill={shirt} />

      <Rect x="17.6" y="24" width="4.8" height="6" rx="2" fill={SKIN} />
      <Ellipse cx="20" cy="18.8" rx="8.2" ry="8.9" fill={SKIN} />
      <Path d="M11.6 17.4Q12 8.4 20 8.4Q28 8.4 28.4 17.4Q25 11.6 19 12Q14 12.2 11.6 17.4Z" fill={HAIR} />
      <Circle cx="11.5" cy="23" r="1.1" fill="#FCD34D" /><Circle cx="28.5" cy="23" r="1.1" fill="#FCD34D" />
      <Brows y={14.8} /><Eyes y={18.4} /><Blush y={21.8} /><Smile y={22.6} />
      <Circle cx="20" cy="11.2" r="0.9" fill="#E0457B" />
    </>
  );
}

/** role + gender -> face icon. `size` is the height in px. Falls back to a neutral person until a gender is chosen. */
export function RoleIcon({ role, gender, size = 30 }: { role: 'owner' | 'tenant'; gender: 'male' | 'female' | null; size?: number }) {
  if (role === 'owner' && gender) {   // the owner: teal clothes, teal ring, house badge
    return (
      <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityLabel="Owner">
        <Defs><ClipPath id="rg-owner-one"><Circle cx="20" cy="20" r="20" /></ClipPath></Defs>
        <Circle cx="20" cy="20" r="20" fill="#fff" />
        <G clipPath="url(#rg-owner-one)">{gender === 'male' ? <ManBody shirt={OWNER} /> : <WomanBody shirt={OWNER} />}</G>
        <Circle cx="20" cy="20" r="18.8" fill="none" stroke={OWNER} strokeWidth="2.4" />
        <Circle cx="30.5" cy="30.5" r="9.4" fill={OWNER} stroke="#fff" strokeWidth="1.8" />
        <Path d="M24.4 30.8L30.5 25L36.6 30.8Z" fill="#fff" />
        <Rect x="26.2" y="30.4" width="8.6" height="6.2" rx="0.7" fill="#fff" />
        <Rect x="29.4" y="32.8" width="2.2" height="3.8" fill={OWNER} />
      </Svg>
    );
  }
  if (role === 'owner') {
    return (
      <Svg width={size * 1.25} height={size} viewBox="0 0 50 40" accessibilityLabel="Owner">
        <Defs><ClipPath id="rg-pair"><Rect width="50" height="40" rx="20" /></ClipPath></Defs>
        <Rect width="50" height="40" rx="20" fill="#fff" />
        <Rect x="0.5" y="0.5" width="49" height="39" rx="19.5" fill="none" stroke="#B7CFC8" strokeWidth="1" />
        <G clipPath="url(#rg-pair)">
          <G transform="translate(-3.4 0)"><WomanBody /></G>
          <G transform="translate(13.4 1)"><ManBody /></G>
        </G>
      </Svg>
    );
  }
  const key = (
    <>
      <Circle cx="30.5" cy="30.5" r="9.4" fill={RENTER} stroke="#fff" strokeWidth="1.8" />
      <Circle cx="27.6" cy="28.4" r="3" fill="none" stroke="#fff" strokeWidth="1.8" />
      <Path d="M29.8 30.6L36.4 37.2M33.6 34.4L35.8 32.2M35.4 36.2L37.2 34.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </>
  );
  if (!gender) {   // neutral person until a gender is chosen: visible on both the dark bar and the pale tab
    return (
      <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityLabel="Renter">
        <Defs><ClipPath id="rg-neutral"><Circle cx="20" cy="20" r="20" /></ClipPath></Defs>
        <Circle cx="20" cy="20" r="19.5" fill="#DCE8FB" />
        <G clipPath="url(#rg-neutral)">
          <Path d="M5 40Q5 27 20 27Q35 27 35 40Z" fill={RENTER} />
          <Circle cx="20" cy="17" r="8" fill={RENTER} />
        </G>
        <Circle cx="20" cy="20" r="18.8" fill="none" stroke={RENTER} strokeWidth="2.4" />
        {key}
      </Svg>
    );
  }
  return (   // the renter: blue clothes, blue ring, key badge
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityLabel="Renter">
      <Defs><ClipPath id="rg-one"><Circle cx="20" cy="20" r="20" /></ClipPath></Defs>
      <Circle cx="20" cy="20" r="20" fill="#fff" />
      <G clipPath="url(#rg-one)">{gender === 'male' ? <ManBody shirt={RENTER} /> : <WomanBody shirt={RENTER} />}</G>
      <Circle cx="20" cy="20" r="18.8" fill="none" stroke={RENTER} strokeWidth="2.4" />
      {key}
    </Svg>
  );
}
