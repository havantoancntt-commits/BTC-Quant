import { useEffect, useRef } from 'react';
import type { AgentId } from '../engine/types';
import {
  AgentWarRoomScene,
  type CameraPreset,
  type SceneSyncPayload,
} from '../three/AgentWarRoomScene';

interface WarRoom3DCanvasProps {
  syncPayload: SceneSyncPayload;
  cameraRequest: { preset: CameraPreset; agentId?: AgentId | null; seq: number } | null;
  onSelectAgent: (agentId: AgentId | null) => void;
}

export function WarRoom3DCanvas({
  syncPayload,
  cameraRequest,
  onSelectAgent,
}: WarRoom3DCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<AgentWarRoomScene | null>(null);
  const onSelectRef = useRef(onSelectAgent);
  onSelectRef.current = onSelectAgent;

  // Mount WebGLRenderer once in dedicated empty ref container
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new AgentWarRoomScene(container, (agentId) => {
      onSelectRef.current(agentId);
    });
    sceneRef.current = scene;

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Sync live market & agent state without recreating WebGL context
  useEffect(() => {
    sceneRef.current?.syncData(syncPayload);
  }, [syncPayload]);

  // Smooth camera preset triggers
  useEffect(() => {
    if (!cameraRequest) return;
    sceneRef.current?.setCameraPreset(cameraRequest.preset, cameraRequest.agentId);
  }, [cameraRequest]);

  return (
    <div
      ref={mountRef}
      data-testid="war-room-3d-canvas"
      className="w-full h-full relative select-none"
      aria-label="Mô phỏng không gian 3D đội Agents giao dịch Bitcoin"
    />
  );
}
