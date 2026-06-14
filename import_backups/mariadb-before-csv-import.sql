/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19-12.3.2-MariaDB, for osx10.21 (arm64)
--
-- Host: 127.0.0.1    Database: pos_db
-- ------------------------------------------------------
-- Server version	12.3.2-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;

--
-- Table structure for table `categories`
--

DROP TABLE IF EXISTS `categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `categories` (
  `id` varchar(36) NOT NULL,
  `name` text NOT NULL,
  `color` text DEFAULT NULL,
  `sortOrder` int(11) DEFAULT 0,
  `isActive` int(11) DEFAULT 1,
  `showOnPos` int(11) DEFAULT 1,
  `createdAt` text DEFAULT NULL,
  `updatedAt` text DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `categories`
--

SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT, @@AUTOCOMMIT=0;
LOCK TABLES `categories` WRITE;
/*!40000 ALTER TABLE `categories` DISABLE KEYS */;
INSERT INTO `categories` VALUES
('27a9aea8-25c9-4040-828d-7a2a4c8da953','Drink','#3b82f6',2,1,1,'2026-06-10T21:17:58.926Z','2026-06-10T21:18:13.173000Z'),
('mock-sync-category-20260607','Mock Sync Category','#7c3aed',999,1,1,'2026-06-07T22:29:36.000Z','2026-06-07T22:29:36.000Z');
/*!40000 ALTER TABLE `categories` ENABLE KEYS */;
UNLOCK TABLES;
COMMIT;
SET AUTOCOMMIT=@OLD_AUTOCOMMIT;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_categories_insert
             BEFORE INSERT ON categories FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_categories_update
             BEFORE UPDATE ON categories FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_delete_categories
             AFTER DELETE ON categories FOR EACH ROW
             INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
             VALUES (CONCAT('categories:', OLD.id), 'categories', OLD.id, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
             ON DUPLICATE KEY UPDATE deletedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `id` varchar(36) NOT NULL,
  `categoryId` varchar(36) DEFAULT NULL,
  `taxRateId` varchar(36) DEFAULT NULL,
  `name` text NOT NULL,
  `sku` varchar(255) DEFAULT NULL,
  `barcode` varchar(255) DEFAULT NULL,
  `price` int(11) NOT NULL,
  `costPrice` int(11) DEFAULT 0,
  `stockLevel` int(11) DEFAULT 0,
  `trackStock` int(11) DEFAULT 0,
  `isWeighable` int(11) DEFAULT 0,
  `showInGoods` int(11) DEFAULT 0,
  `goodsSortOrder` int(11) DEFAULT 0,
  `showInPos` int(11) DEFAULT 1,
  `color` text DEFAULT NULL,
  `image` text DEFAULT NULL,
  `isActive` int(11) DEFAULT 1,
  `createdAt` text DEFAULT NULL,
  `updatedAt` text DEFAULT NULL,
  `allowPriceOverride` int(11) DEFAULT 0,
  `scalePlu` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_products_barcode` (`barcode`),
  UNIQUE KEY `uq_products_scale_plu` (`scalePlu`),
  UNIQUE KEY `uq_products_sku` (`sku`),
  KEY `idx_products_barcode` (`barcode`),
  KEY `idx_products_sku` (`sku`),
  KEY `idx_products_category` (`categoryId`),
  KEY `idx_products_active` (`isActive`),
  KEY `idx_products_scale_plu` (`scalePlu`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `products`
--

SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT, @@AUTOCOMMIT=0;
LOCK TABLES `products` WRITE;
/*!40000 ALTER TABLE `products` DISABLE KEYS */;
INSERT INTO `products` VALUES
('0c01641e-fd86-4172-ac21-26ce18dbe444','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Saxa',NULL,'5000354924408',1600,0,0,0,0,0,0,1,'#3b82f6','',1,'2026-06-11T21:15:26.583000Z','2026-06-12T08:03:46.375000Z',0,NULL),
('1515d7c0-ef16-47f5-a003-1dcd86f8c650','27a9aea8-25c9-4040-828d-7a2a4c8da953','tax-standard-vat','Effes Beer 500mm','4038745641055','4038745641055',399,0,0,0,0,0,0,1,'#3b82f6','',1,'2026-06-11T17:01:52.614000Z','2026-06-12T17:01:45.170000Z',0,NULL),
('23dd0202-4c70-4589-b03f-34490b227525','mock-sync-category-20260607','tax-standard-vat','hama','hama','1313',698,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-07T22:40:54.580Z','2026-06-13T09:05:31.671000Z',0,NULL),
('2ba82847-c7d9-4006-8d84-db3dc25b6b14','mock-sync-category-20260607','tax-standard-vat','tata','tata','7878',23,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-08T13:27:03.308Z','2026-06-12T00:18:47.282000Z',0,NULL),
('3b184411-9321-4c79-99a3-377df85bbfa9','mock-sync-category-20260607','tax-standard-vat','shera','shera','3434',8800,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-08T02:39:56.272Z','2026-06-12T09:20:42.030000Z',0,NULL),
('5050b2cc-3f64-4629-b8b3-d08589f28087','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Highland Sparkling 1l','5010459005025','5010459005025',199,0,0,0,0,0,0,1,'#3b82f6','',1,'2026-06-11T16:29:40.600000Z','2026-06-12T17:01:45.170000Z',0,NULL),
('84d8658c-ae2c-4369-8674-aeb009dbed9f','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','loyd','5900396036827','5900396036827',299,0,0,0,0,0,0,1,'#3b82f6','',0,'2026-06-11T21:00:00.007000Z','2026-06-12T00:18:47.282000Z',0,NULL),
('89f66945-b6a1-4ee3-b1ae-c01b74ed7600','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Tomato',NULL,NULL,400,0,0,0,1,0,0,1,'#22c55e','',1,'2026-06-10T21:33:56.786Z','2026-06-12T08:03:46.375000Z',0,'33344'),
('8d543fba-3474-4108-938c-321adc4700a2','mock-sync-category-20260607','tax-standard-vat','shera tra',NULL,NULL,33,0,0,0,0,0,0,1,'#a855f7','',0,'2026-06-10T21:16:34.479Z','2026-06-12T08:03:46.375000Z',0,NULL),
('8dba7510-c1de-48e4-91d7-6b325cc2a95a','mock-sync-category-20260607','tax-standard-vat','Grocery',NULL,NULL,3,0,0,0,0,0,0,1,'#f97316','',1,'2026-06-10T21:05:44.914Z','2026-06-12T08:03:46.375000Z',0,'12121'),
('a668303a-4a1f-4b22-88bc-e401e5de652c','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Fairy 500ml','8700216585682','8700216585682',699,0,0,1,0,0,0,1,'#3b82f6','',1,'2026-06-11T13:55:44.178000Z','2026-06-12T17:01:45.170000Z',0,NULL),
('afa2f096-4ec9-4b04-92ab-d1b67beffec0','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Loyd','5900396033727','5900396033727',299,0,0,0,0,0,0,1,'#3b82f6','',0,'2026-06-11T20:59:20.235000Z','2026-06-12T00:18:47.282000Z',0,NULL),
('c7ab7be6-9fc4-4d6b-9609-237f77613ded','27a9aea8-25c9-4040-828d-7a2a4c8da953','tax-standard-vat','Rghba','6291106067415','6291106067415',299,0,0,0,0,0,0,1,'#3b82f6','',1,'2026-06-11T14:39:29.067000Z','2026-06-12T17:01:45.170000Z',0,NULL),
('ce4ba23d-620c-441d-9021-56d3969cc96d','mock-sync-category-20260607','tax-standard-vat','goods',NULL,'00110011',1,0,0,0,0,1,1,1,'#f97316','',1,'2026-06-08T02:43:17.218Z','2026-06-12T08:03:46.375000Z',0,NULL),
('d6e14e9a-6c40-4e4b-8d1c-0c7f7f2dc802','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Aryan ','5900820024024','5900820024024',299,0,0,0,0,0,0,1,'#3b82f6','',0,'2026-06-11T20:41:41.270000Z','2026-06-12T00:18:47.282000Z',0,NULL),
('e17781dd-5d94-4dee-837a-52636bb37d35','mock-sync-category-20260607','tax-standard-vat','arda','arda','1212',800,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-07T22:32:30.996Z','2026-06-12T00:18:47.282000Z',0,NULL),
('ebbe5fb3-2e6c-4de2-9a94-3823ee6c1fca','27a9aea8-25c9-4040-828d-7a2a4c8da953','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Ganjo',NULL,'2323',5555,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-11T13:06:58.441Z','2026-06-12T08:03:46.375000Z',0,NULL),
('f207f6d8-e646-4d89-8c58-873b063146cf','mock-sync-category-20260607','tax-standard-vat','Meat',NULL,NULL,3,0,0,0,0,0,0,1,'#6366f1','',1,'2026-06-10T20:47:08.707Z','2026-06-12T08:03:46.375000Z',0,'12345'),
('f5b821de-a3ea-453f-8fbb-70162ccde714','mock-sync-category-20260607','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Watermelon',NULL,NULL,129,0,0,0,1,0,0,1,'#0ea5e9','',1,'2026-06-10T22:55:02.074Z','2026-06-12T08:03:46.375000Z',0,'11234'),
('mock-sync-product-20260607','mock-sync-category-20260607','cac06901-a2c4-40e7-b6d2-2152dd2b6c74','Mock Sync Product','MOCK-SYNC-001','9900000000001',2222,125,0,1,0,0,0,1,'#7c3aed',NULL,1,'2026-06-07T22:29:36.000Z','2026-06-12T00:18:47.282000Z',0,NULL);
/*!40000 ALTER TABLE `products` ENABLE KEYS */;
UNLOCK TABLES;
COMMIT;
SET AUTOCOMMIT=@OLD_AUTOCOMMIT;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_products_insert
             BEFORE INSERT ON products FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_products_update
             BEFORE UPDATE ON products FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_delete_products
             AFTER DELETE ON products FOR EACH ROW
             INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
             VALUES (CONCAT('products:', OLD.id), 'products', OLD.id, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
             ON DUPLICATE KEY UPDATE deletedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` varchar(36) NOT NULL,
  `name` text NOT NULL,
  `phone` text DEFAULT NULL,
  `email` text DEFAULT NULL,
  `loyaltyPoints` int(11) DEFAULT 0,
  `notes` text DEFAULT NULL,
  `createdAt` text DEFAULT NULL,
  `updatedAt` text DEFAULT NULL,
  `postcode` text DEFAULT NULL,
  `loyaltyCode` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `customers`
--

SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT, @@AUTOCOMMIT=0;
LOCK TABLES `customers` WRITE;
/*!40000 ALTER TABLE `customers` DISABLE KEYS */;
INSERT INTO `customers` VALUES
('a54577f9-8abc-49bb-ba55-0bad42d381a5','rasty','','',15,'','2026-06-11T01:50:30.399Z','2026-06-11T01:55:17.620000Z','','121212'),
('c9594b8f-fb9e-429a-bb29-41fd8302a6cd','Karim','','',0,'','2026-06-11T01:03:22.998Z','2026-06-11T01:48:26.898000Z','','LB88514374');
/*!40000 ALTER TABLE `customers` ENABLE KEYS */;
UNLOCK TABLES;
COMMIT;
SET AUTOCOMMIT=@OLD_AUTOCOMMIT;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_customers_insert
             BEFORE INSERT ON customers FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_stamp_customers_update
             BEFORE UPDATE ON customers FOR EACH ROW SET NEW.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'PIPES_AS_CONCAT,IGNORE_SPACE,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER IF NOT EXISTS pos_delete_customers
             AFTER DELETE ON customers FOR EACH ROW
             INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
             VALUES (CONCAT('customers:', OLD.id), 'customers', OLD.id, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
             ON DUPLICATE KEY UPDATE deletedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') 
*/;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;

-- Dump completed on 2026-06-13 23:21:13
