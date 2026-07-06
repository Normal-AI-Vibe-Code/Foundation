import { memo, useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  MediaMeta,
  moveMedia,
  removeMedia,
  resizeMedia,
  setMediaFlag,
} from "../state/store";
import { ObjectFrame } from "./ObjectFrame";

interface Props {
  item: MediaMeta;
  pos: { x: number; y: number };
  isActive: boolean;
  getScale(): number;
}

const iconSpring = { type: "spring", stiffness: 500, damping: 22 } as const;

export const MediaView = memo(function MediaView({ item, pos, isActive, getScale }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // keep the <video> element in line with the autoplay/mute flags
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = item.muted;
    if (item.autoplay) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [item.autoplay, item.muted]);

  const extras =
    item.media === "video" ? (
      <>
        <motion.button
          className={"icon-btn media-flag" + (item.autoplay ? " on" : "")}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.85 }}
          transition={iconSpring}
          title={item.autoplay ? "Autoplay on — click to pause" : "Autoplay off — click to play"}
          onClick={() => setMediaFlag(item.id, { autoplay: !item.autoplay })}
        >
          {item.autoplay ? "❚❚" : "▶"}
        </motion.button>
        <motion.button
          className={"icon-btn media-flag" + (item.muted ? "" : " on")}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.85 }}
          transition={iconSpring}
          title={item.muted ? "Sound off" : "Sound on"}
          onClick={() => setMediaFlag(item.id, { muted: !item.muted })}
        >
          {item.muted ? "🔇" : "🔊"}
        </motion.button>
      </>
    ) : undefined;

  return (
    <ObjectFrame
      id={item.id}
      title={item.name}
      pos={pos}
      width={item.w}
      float={item.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => moveMedia(item.id, x, y)}
      onResize={(dw, dh) => resizeMedia(item.id, item.w + dw, item.h + dh)}
      onRemove={() => removeMedia(item.id)}
      headerExtras={extras}
      bodyClass="media-body"
    >
      {item.media === "image" ? (
        <img
          src={item.src}
          alt={item.name}
          style={{ width: item.w, height: item.h }}
          draggable={false}
        />
      ) : (
        <video
          ref={videoRef}
          src={item.src}
          style={{ width: item.w, height: item.h }}
          muted={item.muted}
          autoPlay={item.autoplay}
          loop
          playsInline
          controls={!item.autoplay}
        />
      )}
    </ObjectFrame>
  );
});
