// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
/* global FS, Module */
if (typeof FS !== "undefined" && FS.filesystems && FS.filesystems.WORKERFS) {
  Module["WORKERFS"] = FS.filesystems.WORKERFS;
}

