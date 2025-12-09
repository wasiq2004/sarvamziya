const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdf = require('pdf-parse');
const { DocumentService } = require('../documentService'); // Changed from services/documentService because it's in root server dir based on file listing
const mysqlPool = require('../config/database');

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const documentService = new DocumentService(mysqlPool);

/**
 * POST /api/documents/upload
 * Upload and parse a document
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { userId, agentId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        let content = '';
        const buffer = req.file.buffer;
        const mimetype = req.file.mimetype;
        const originalName = req.file.originalname;

        console.log(`Processing upload: ${originalName} (${mimetype})`);

        // Parse content based on file type
        if (mimetype === 'application/pdf') {
            try {
                const data = await pdf(buffer);
                content = data.text;
                console.log(`Parsed PDF, extracted ${content.length} characters`);
            } catch (err) {
                console.error('Error parsing PDF:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to parse PDF file'
                });
            }
        } else if (mimetype === 'text/plain' || mimetype === 'text/markdown' || mimetype === 'text/csv') {
            content = buffer.toString('utf-8');
        } else {
            // For other types, try to treat as text, but warn
            console.warn(`Unknown mimetype ${mimetype}, trying to read as text`);
            content = buffer.toString('utf-8');
        }

        // Clean up content (remove excessive whitespace)
        content = content.replace(/\s+/g, ' ').trim();

        if (content.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Extracted content is empty'
            });
        }

        // Save to database
        const document = await documentService.uploadDocument(userId, originalName, content, agentId);

        res.json({
            success: true,
            data: document
        });

    } catch (error) {
        console.error('Error in upload route:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/documents/:userId
 * Get all documents for a user
 */
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { agentId } = req.query;

        const documents = await documentService.getDocuments(userId, agentId);

        res.json({
            success: true,
            data: documents
        });
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/documents/content/:documentId
 * Get document content
 */
router.get('/content/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;

        const content = await documentService.getDocumentContent(documentId);

        if (!content) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        res.json({
            success: true,
            data: { content }
        });
    } catch (error) {
        console.error('Error fetching document content:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * DELETE /api/documents/:documentId
 * Delete a document
 */
router.delete('/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;

        await documentService.deleteDocument(documentId);

        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting document:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
