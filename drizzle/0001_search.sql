-- Full-text index over request titles and descriptions (external content).
CREATE VIRTUAL TABLE `request_fts` USING fts5(
  title,
  body,
  content='request',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `request_fts`(rowid, title, body) SELECT id, title, body FROM `request`;
--> statement-breakpoint
CREATE TRIGGER `request_fts_ai` AFTER INSERT ON `request` BEGIN
  INSERT INTO `request_fts`(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `request_fts_ad` AFTER DELETE ON `request` BEGIN
  INSERT INTO `request_fts`(`request_fts`, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `request_fts_au` AFTER UPDATE OF title, body ON `request` BEGIN
  INSERT INTO `request_fts`(`request_fts`, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO `request_fts`(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
