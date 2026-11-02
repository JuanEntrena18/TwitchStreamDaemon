import { useId } from 'react';

interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 40, className = '' }: Props) {
  const uid = useId().replace(/:/g, '');
  const outerGradId = `sdOuter_${uid}`;
  const coreGradId = `sdCore_${uid}`;
  const hornGradId = `sdHorn_${uid}`;
  const visorGradId = `sdVisor_${uid}`;
  const glowFilterId = `sdGlow_${uid}`;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="StreamDaemon Logo"
    >
      <defs>
        {/* Outer Armor Frame Gradient */}
        <linearGradient id={outerGradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="45%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>

        {/* Deep Obsidian Shield Core */}
        <linearGradient id={coreGradId} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#1e1338" />
          <stop offset="55%" stopColor="#0f0a1e" />
          <stop offset="100%" stopColor="#070510" />
        </linearGradient>

        {/* Cyber Daemon Crest Gradient */}
        <linearGradient id={hornGradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="65%" stopColor="#e9d5ff" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>

        {/* Neon Visor Eyes / Signal Accent */}
        <linearGradient id={visorGradId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="50%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#f43f5e" />
        </linearGradient>

        {/* Unclipped Soft Glow */}
        <filter id={glowFilterId} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#8b5cf6" floodOpacity="0.45" />
        </filter>
      </defs>

      {/* Outer Hexagonal Cyber Shield with Glow */}
      <polygon
        points="60,6 106,32 106,88 60,114 14,88 14,32"
        fill={`url(#${outerGradId})`}
        filter={`url(#${glowFilterId})`}
      />

      {/* Inner Obsidian Armor Plate */}
      <polygon
        points="60,11 101,35 101,85 60,109 19,85 19,35"
        fill={`url(#${coreGradId})`}
      />

      {/* Subtle Inner Bevel Hairline */}
      <polygon
        points="60,16 96,37 96,83 60,104 24,83 24,37"
        fill="none"
        stroke="rgba(192, 132, 252, 0.25)"
        strokeWidth="1.2"
      />

      {/* Top Broadcast Signal Arcs */}
      <path
        d="M 47 28 A 18 18 0 0 1 73 28"
        fill="none"
        stroke="#22d3ee"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.85"
      />
      <circle cx="60" cy="31" r="2.6" fill="#22d3ee" />

      {/* Cyber-Daemon Horns & Angular Mecha Mask */}
      <path
        d="
          M 30 26
          L 46 42
          L 54 38
          L 60 43
          L 66 38
          L 74 42
          L 90 26
          L 86 52
          L 91 62
          L 78 86
          L 60 98
          L 42 86
          L 29 62
          L 34 52
          Z
        "
        fill={`url(#${hornGradId})`}
      />

      {/* Inner Mask Faceplate Cutout */}
      <path
        d="
          M 39 50
          L 53 55
          L 60 51
          L 67 55
          L 81 50
          L 83 63
          L 73 81
          L 60 90
          L 47 81
          L 37 63
          Z
        "
        fill="#120b24"
      />

      {/* Glowing Cyber Visor Eyes */}
      <polygon
        points="41,57 56,62 54,68 39,63"
        fill={`url(#${visorGradId})`}
      />
      <polygon
        points="79,57 64,62 66,68 81,63"
        fill={`url(#${visorGradId})`}
      />

      {/* Visor Eye Highlights */}
      <polygon points="43,58.5 53,62 52,64.5 42,61" fill="#ffffff" opacity="0.9" />
      <polygon points="77,58.5 67,62 68,64.5 78,61" fill="#ffffff" opacity="0.9" />

      {/* Lower Cyber Fang / Broadcast Equalizer Vent */}
      <path
        d="M 48 75 L 54 71 L 60 76 L 66 71 L 72 75 L 67 83 L 60 86 L 53 83 Z"
        fill={`url(#${outerGradId})`}
        opacity="0.95"
      />
    </svg>
  );
}
