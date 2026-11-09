import { describe, expect, it } from "vitest";

import {
  decodeSpatialiteBlob,
  encodeSpatialiteLineString,
  encodeSpatialitePoint,
} from "../src/spatialite/blob-codec.js";
import { SpatialiteDatabase } from "../src/spatialite/database.js";

const AEQUILIBRAE_SCHEMA = `
CREATE TABLE modes (
  mode_id TEXT PRIMARY KEY,
  mode_name TEXT,
  description TEXT
);

CREATE TABLE link_types (
  link_type TEXT PRIMARY KEY,
  link_type_id TEXT,
  description TEXT
);

CREATE TABLE nodes (
  node_id INTEGER PRIMARY KEY,
  is_centroid INTEGER DEFAULT 0,
  modes TEXT,
  link_types TEXT,
  geometry BLOB
);

CREATE TABLE links (
  link_id INTEGER PRIMARY KEY,
  a_node INTEGER,
  b_node INTEGER,
  direction INTEGER DEFAULT 1,
  distance NUMERIC,
  modes TEXT DEFAULT 'c',
  link_type TEXT DEFAULT 'default',
  geometry BLOB
);

INSERT INTO modes VALUES ('c', 'Car', 'Standard car');
INSERT INTO link_types VALUES ('default', 'd', 'Default link type');
`;

const AEQUILIBRAE_TRIGGERS = `
-- 1. Create a_node if endpoint is empty space
CREATE TRIGGER aequilibrae_new_link_a_node BEFORE INSERT ON links
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes WHERE nodes.geometry = StartPoint(new.geometry)
  )
  BEGIN
    INSERT INTO nodes (node_id, geometry)
    VALUES ((SELECT coalesce(max(node_id) + 1, 1) FROM nodes), StartPoint(new.geometry));
  END;

-- 2. Create b_node if endpoint is empty space
CREATE TRIGGER aequilibrae_new_link_b_node BEFORE INSERT ON links
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes WHERE nodes.geometry = EndPoint(new.geometry)
  )
  BEGIN
    INSERT INTO nodes (node_id, geometry)
    VALUES ((SELECT coalesce(max(node_id) + 1, 1) FROM nodes), EndPoint(new.geometry));
  END;

-- 3. Set a_node, b_node, and distance AFTER link creation
CREATE TRIGGER aequilibrae_new_link AFTER INSERT ON links
  BEGIN
    UPDATE links
    SET a_node = (SELECT node_id FROM nodes WHERE nodes.geometry = StartPoint(new.geometry)),
        b_node = (SELECT node_id FROM nodes WHERE nodes.geometry = EndPoint(new.geometry)),
        distance = GeodesicLength(new.geometry)
    WHERE links.ROWID = new.ROWID;

    UPDATE links
    SET link_id = (SELECT coalesce(max(link_id), 0) + 1 FROM links)
    WHERE ROWID = new.ROWID AND new.link_id IS NULL;
  END;

-- 4. Move node cascades to connected links
CREATE TRIGGER aequilibrae_update_node_geometry AFTER UPDATE OF geometry ON nodes
  WHEN new.geometry IS NOT old.geometry
  BEGIN
    UPDATE links
    SET geometry = SetStartPoint(geometry, new.geometry)
    WHERE a_node = new.node_id AND StartPoint(geometry) != new.geometry;

    UPDATE links
    SET geometry = SetEndPoint(geometry, new.geometry)
    WHERE b_node = new.node_id AND EndPoint(geometry) != new.geometry;
  END;

-- 5. Delete lonely nodes AFTER link deleted
CREATE TRIGGER aequilibrae_deleted_link AFTER DELETE ON links
  BEGIN
    DELETE FROM nodes
    WHERE node_id IN (old.a_node, old.b_node)
      AND is_centroid != 1
      AND NOT EXISTS (SELECT 1 FROM links WHERE links.a_node = nodes.node_id)
      AND NOT EXISTS (SELECT 1 FROM links WHERE links.b_node = nodes.node_id);
  END;

-- 6. Centroid cannibalization guard
CREATE TRIGGER aequilibrae_cannibalize_node_abort_when_centroid BEFORE UPDATE OF geometry ON nodes
  WHEN EXISTS (
    SELECT 1 FROM nodes AS collision
    WHERE collision.ROWID != old.ROWID
      AND collision.geometry = new.geometry
      AND (collision.is_centroid = 1 OR old.is_centroid = 1 OR new.is_centroid = 1)
  )
  BEGIN
    SELECT RAISE(ABORT, 'Cannot cannibalize centroids');
  END;
`;

describe("AequilibraE Real Trigger Execution in SpatiaLite Engine", () => {
  it("automatically creates nodes and links graph topology when drawing a link", async () => {
    const db = await SpatialiteDatabase.open();
    db.exec(AEQUILIBRAE_SCHEMA);
    db.exec(AEQUILIBRAE_TRIGGERS);

    // Initial state: 0 nodes, 0 links
    expect(db.query("SELECT count(*) as count FROM nodes;")[0]?.count).toBe(0);
    expect(db.query("SELECT count(*) as count FROM links;")[0]?.count).toBe(0);

    // Draw link from Brisbane [153.025, -27.469] to Gold Coast [153.400, -28.000]
    const linkGeom = encodeSpatialiteLineString([
      [153.025, -27.469],
      [153.4, -28.0],
    ]);

    db.rawDb.run("INSERT INTO links (modes, link_type, geometry) VALUES ('c', 'default', ?);", [linkGeom]);

    // Triggers must have auto-created 2 nodes!
    const nodes = db.query<{ node_id: number; is_centroid: number }>("SELECT node_id, is_centroid FROM nodes ORDER BY node_id;");
    expect(nodes.length).toBe(2);

    // The link must have its a_node, b_node, link_id, and distance > 50,000m
    const links = db.query<{ link_id: number; a_node: number; b_node: number; distance: number }>(
      "SELECT link_id, a_node, b_node, distance FROM links;",
    );
    expect(links.length).toBe(1);
    expect(links[0]?.link_id).toBe(1);
    expect(links[0]?.a_node).toBeDefined();
    expect(links[0]?.b_node).toBeDefined();
    expect(links[0]?.distance).toBeGreaterThan(60000);
    expect(links[0]?.distance).toBeLessThan(80000);

    db.close();
  });

  it("cascades node movement to connected link endpoints", async () => {
    const db = await SpatialiteDatabase.open();
    db.exec(AEQUILIBRAE_SCHEMA);
    db.exec(AEQUILIBRAE_TRIGGERS);

    const linkGeom = encodeSpatialiteLineString([
      [0.0, 0.0],
      [1.0, 1.0],
    ]);
    db.rawDb.run("INSERT INTO links (modes, link_type, geometry) VALUES ('c', 'default', ?);", [linkGeom]);

    const linksBefore = db.query<{ a_node: number; b_node: number }>("SELECT a_node, b_node FROM links;");
    const aNodeId = linksBefore[0]?.a_node;
    expect(aNodeId).toBeDefined();
    if (!aNodeId) return;

    // Move a_node from [0, 0] to [0.5, 0.5]
    const movedPoint = encodeSpatialitePoint(0.5, 0.5);
    db.rawDb.run("UPDATE nodes SET geometry = ? WHERE node_id = ?;", [movedPoint, aNodeId]);

    // Check that link's start vertex cascaded to [0.5, 0.5]!
    const linkRow = db.query<{ geometry: Uint8Array }>("SELECT geometry FROM links WHERE link_id = 1;")[0];
    expect(linkRow).toBeDefined();
    if (!linkRow) return;

    const decodedLink = decodeSpatialiteBlob(linkRow.geometry);
    expect(decodedLink.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [0.5, 0.5],
        [1.0, 1.0],
      ],
    });

    db.close();
  });

  it("garbage-collects lonely nodes when a link is deleted", async () => {
    const db = await SpatialiteDatabase.open();
    db.exec(AEQUILIBRAE_SCHEMA);
    db.exec(AEQUILIBRAE_TRIGGERS);

    const linkGeom = encodeSpatialiteLineString([
      [10.0, 10.0],
      [20.0, 20.0],
    ]);
    db.rawDb.run("INSERT INTO links (modes, link_type, geometry) VALUES ('c', 'default', ?);", [linkGeom]);
    expect(db.query("SELECT count(*) as count FROM nodes;")[0]?.count).toBe(2);

    // Delete the link
    db.exec("DELETE FROM links WHERE link_id = 1;");

    // Lonely nodes must have been cleaned up automatically!
    expect(db.query("SELECT count(*) as count FROM nodes;")[0]?.count).toBe(0);

    db.close();
  });

  it("prevents cannibalizing centroids and raises ABORT", async () => {
    const db = await SpatialiteDatabase.open();
    db.exec(AEQUILIBRAE_SCHEMA);
    db.exec(AEQUILIBRAE_TRIGGERS);

    // Insert centroid at [0, 0]
    const p1 = encodeSpatialitePoint(0, 0);
    db.rawDb.run("INSERT INTO nodes (node_id, is_centroid, geometry) VALUES (1, 1, ?);", [p1]);

    // Insert regular node at [1, 1]
    const p2 = encodeSpatialitePoint(1, 1);
    db.rawDb.run("INSERT INTO nodes (node_id, is_centroid, geometry) VALUES (2, 0, ?);", [p2]);

    // Attempt to move node 2 on top of centroid node 1 ([0, 0])
    expect(() => {
      db.rawDb.run("UPDATE nodes SET geometry = ? WHERE node_id = 2;", [p1]);
    }).toThrow(/Cannot cannibalize centroids/);

    db.close();
  });
});
