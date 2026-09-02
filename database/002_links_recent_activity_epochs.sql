-- Forward-only compatibility delta for the compact last-100 activity ring.
-- Exact shape is proven by the clean portable PHP schema with SHA-256:
-- 9d541b30fede970c2c36612e5799d76446b72ab1eab770df7349ceb569c4876b
--
-- Manual application only. Run the read-only schema gate first. This statement
-- intentionally fails if the column already exists so a wrong existing shape
-- is never silently accepted. It contains no DROP or data rewrite statement.

ALTER TABLE `links`
  ADD COLUMN `recent_activity_epochs` LONGTEXT
    CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER `filtered_c6`;
