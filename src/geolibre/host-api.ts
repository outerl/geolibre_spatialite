// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { Feature, FeatureCollection, Geometry } from "geojson";

export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style"
  | "replace-style"
  | "replace-layers";

export interface GeoLibreSelection {
  layerId: string | null;
  features: Feature<Geometry | null>[];
}

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string | (() => string);
  dock?: GeoLibreRightPanelDock;
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => undefined | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}

export type GeoLibreToolbarMenuItem =
  | {
      type?: "action";
      id: string;
      label: string;
      icon?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: "submenu";
      id: string;
      label: string;
      icon?: string;
      items: GeoLibreToolbarMenuItem[];
    }
  | { type: "separator"; id?: string };

export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

export interface GeoLibreMapLike {
  addSource: (id: string, source: Record<string, unknown>) => void;
  getSource: (id: string) => unknown;
  removeSource: (id: string) => void;
  addLayer: (layer: Record<string, unknown>, beforeId?: string) => void;
  getLayer: (id: string) => unknown;
  removeLayer: (id: string) => void;
  setPaintProperty: (layerId: string, property: string, value: unknown) => void;
  setLayoutProperty: (layerId: string, property: string, value: unknown) => void;
}

export interface GeoLibreExternalNativeLayerRegistration {
  id: string;
  name: string;
  nativeLayerIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  geojson?: FeatureCollection;
  opacity?: number;
  paintMode?: "geolibre" | "plugin";
}

export interface GeoLibreAppAPI {
  addGeoJsonLayer: (name: string, data: FeatureCollection, sourcePath?: string) => string;
  onSelectionChange?: (callback: (selection: GeoLibreSelection) => void) => () => void;
  addLayerGroup?: (name?: string, layerIds?: string[]) => string;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getMap?: () => GeoLibreMapLike | null;
  registerExternalNativeLayer?: (layer: GeoLibreExternalNativeLayerRegistration) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  unregisterToolbarMenu?: (id: string) => void;
  // Hosts may return a disposer or use unregisterService instead.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  registerService?: (name: string, service: unknown) => void | (() => void);
  unregisterService?: (name: string) => void;
  getService?: (name: string) => unknown;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => boolean | undefined;
}
