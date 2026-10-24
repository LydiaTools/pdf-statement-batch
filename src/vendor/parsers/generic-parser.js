/**
 * Generic Bank Statement Parser
 * 
 * Fallback parser for unrecognized bank statement formats.
 * 
 * Two parsing strategies:
 * 1. Position-based parsing (preferred) - Uses word positions for accurate column detection
 * 2. Text-based parsing (fallback) - Uses heuristics on plain text
 * 
 * Position-based parsing:
 * - Detects table headers by pattern matching
 * - Uses line gaps to find table boundaries
 * - Associates words with columns based on x-coordinate overlap
 * - Groups multi-line descriptions using date column as row delimiter
 */

import {
    parseDate,
    isDate,
    parseAmount,
    splitLines,
    cleanDescription,
    extractStatementPeriod,
    isTransactionStart,
    createResult,
    DATE_PATTERNS,
    SECTION_PATTERNS,
    END_OF_TABLE_PATTERNS,
    computeConfidence,
    validateTransactions
} from './base-parser.js';

import { parseWithPositions as positionParse } from './position-parser.js';
import { parseWithRectangles } from './rectangle-parser.js';

// Generic headers when we can't determine exact structure
const GENERIC_HEADERS = ['Date', 'Description', 'Amount'];

// Amount patterns to look for (non-anchored for searching within strings)
const AMOUNT_PATTERNS = [
    /\$[\d,]+\.\d{2}/,           // $1,234.56
    /-?\$[\d,]+\.\d{2}/,         // -$1,234.56
    /[\d,]+\.\d{2}-/,            // 1,234.56- (trailing negative, US Bank style)
    /[\d,]+\.\d{2}\s*(CR|DR)?/i  // 1,234.56 CR/DR
];

/**
 * Check if a string matches any date pattern
 * 
 * @param {string} str - String to check
 * @returns {boolean} True if string looks like a date
 */
function looksLikeDate(str) {
    if (!str) return false;
    const trimmed = str.trim();
    return DATE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Check if a string contains an amount
 * 
 * @param {string} str - String to check
 * @returns {boolean} True if string contains an amount
 */
function containsAmount(str) {
    if (!str) return false;
    return AMOUNT_PATTERNS.some(pattern => pattern.test(str));
}

/**
 * Extract amount from a string
 * 
 * @param {string} str - String containing amount
 * @returns {number|null} Extracted amount or null
 */
function extractAmount(str) {
    if (!str) return null;
    
    for (const pattern of AMOUNT_PATTERNS) {
        const match = str.match(pattern);
        if (match) {
            let amountStr = match[0];
            
            // Check for CR (credit) or DR (debit) suffix
            const hasCR = /CR$/i.test(amountStr);
            const hasDR = /DR$/i.test(amountStr);
            // Check for trailing negative (e.g. "6,000.00-")
            const hasTrailingNeg = /\d-$/.test(amountStr);

            // Clean the amount string
            amountStr = amountStr.replace(/[$,CR\sDR-]/gi, '');
            let amount = parseFloat(amountStr);

            if (!isNaN(amount)) {
                // CR typically means credit (positive), DR means debit (negative)
                if (hasDR || hasTrailingNeg) amount = -amount;
                return amount;
            }
        }
    }
    
    return null;
}

/**
 * Try to parse a line as a transaction
 * 
 * @param {string} line - Line to parse
 * @returns {Object|null} Parsed transaction or null
 */
function tryParseTransaction(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return null;
    
    // Look for a date at the start
    let date = null;
    let dateEndIndex = 0;
    
    for (let i = 0; i < Math.min(3, parts.length); i++) {
        if (looksLikeDate(parts[i])) {
            date = parts[i];
            dateEndIndex = i + 1;
            break;
        }
        // Try combining parts (e.g., "Mar 15, 2024")
        if (i < parts.length - 1) {
            const combined = parts.slice(0, i + 2).join(' ');
            if (looksLikeDate(combined)) {
                date = combined;
                dateEndIndex = i + 2;
                break;
            }
        }
    }
    
    if (!date) return null;
    
    // Look for an amount at the end
    let amount = null;
    let amountStartIndex = parts.length;
    
    for (let i = parts.length - 1; i >= dateEndIndex; i--) {
        const potentialAmount = extractAmount(parts[i]);
        if (potentialAmount !== null) {
            amount = potentialAmount;
            amountStartIndex = i;
            break;
        }
        // Try combining with previous part (e.g., "- $100.00")
        if (i > dateEndIndex) {
            const combined = parts.slice(i - 1, i + 1).join('');
            const combinedAmount = extractAmount(combined);
            if (combinedAmount !== null) {
                amount = combinedAmount;
                amountStartIndex = i - 1;
                break;
            }
        }
    }
    
    // Extract description (everything between date and amount)
    const description = parts.slice(dateEndIndex, amountStartIndex).join(' ');
    
    // Only return if we have at least a date and either description or amount
    if (date && (description || amount !== null)) {
        return {
            date,
            description: cleanDescription(description),
            amount: amount || 0
        };
    }
    
    return null;
}

/**
 * Detect the current section from a line of text
 * 
 * Sections like "DEPOSITS AND ADDITIONS" or "ELECTRONIC WITHDRAWALS" affect
 * the sign of amounts. Returns the section sign (+1 / -1 / null) or null
 * if the line is not a section header.
 * 
 * @param {string} line - Line text
 * @returns {number|null} Amount sign for this section, or null if not a section
 */
function detectSection(line) {
    for (const { pattern, sign } of SECTION_PATTERNS) {
        if (pattern.test(line)) {
            return sign;
        }
    }
    return null;
}

/**
 * Check if a line looks like a continuation of the previous transaction
 * 
 * Uses multiple heuristics: no date at start, no standalone amount,
 * not a section header, not an end-of-table marker, and reasonable length.
 * Also detects indentation as a continuation signal.
 * 
 * @param {string} line - Raw line text (not trimmed)
 * @param {string} trimmed - Trimmed line text
 * @returns {boolean} True if line is likely a continuation
 */
function isContinuationLine(line, trimmed) {
    if (!trimmed || trimmed.length <= 2) return false;
    
    // Not a continuation if starts with a date
    const firstWord = trimmed.split(/\s+/)[0];
    if (looksLikeDate(firstWord)) return false;
    
    // Not a continuation if it IS an amount with no other text
    if (containsAmount(trimmed) && trimmed.replace(/[-$\d,.\s]/g, '').length < 3) return false;
    
    // Not a continuation if it's a section header or end marker
    if (detectSection(trimmed) !== null) return false;
    if (END_OF_TABLE_PATTERNS.some(p => p.test(trimmed))) return false;
    
    // Not a continuation if starts with common non-transaction keywords
    if (/^(Total|Balance|Summary|Page\s+\d|Account|Statement|Interest)/i.test(trimmed)) return false;
    
    // Indented lines are a strong continuation signal
    const leadingSpaces = line.length - line.trimStart().length;
    if (leadingSpaces >= 4) return true;
    
    // Otherwise accept if it has enough text content
    return trimmed.length > 3;
}

/**
 * Try to parse tab-separated line as a transaction
 * 
 * Some PDF extractors produce tab-separated output. Handle this case by
 * splitting on tabs and mapping columns positionally.
 * 
 * @param {string} line - Line with potential tabs
 * @returns {Object|null} Parsed transaction or null
 */
function tryParseTabSeparated(line) {
    if (!line.includes('\t')) return null;
    
    const parts = line.split('\t').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    
    // Try to identify date, description, and amount from tab-separated parts
    let date = null;
    let description = '';
    let amount = 0;
    
    for (let i = 0; i < parts.length; i++) {
        if (!date && looksLikeDate(parts[i])) {
            date = parts[i];
        } else if (containsAmount(parts[i])) {
            const extracted = extractAmount(parts[i]);
            if (extracted !== null) amount = extracted;
        } else if (parts[i].length > 2) {
            description += (description ? ' ' : '') + parts[i];
        }
    }
    
    if (date && (description || amount !== 0)) {
        return { date, description: cleanDescription(description), amount };
    }
    return null;
}

/**
 * Main parsing function for generic statements (text-based fallback)
 * 
 * Enhanced with:
 * - Section awareness (applies sign based on DEPOSITS / WITHDRAWALS sections)
 * - Improved continuation detection (indentation + heuristics)
 * - Tab-separated value support
 * - End-of-table marker filtering
 * 
 * @param {string} text - Extracted PDF text
 * @returns {Object} Parser result with transactions, headers, and metadata
 */
function parse(text) {
    if (!text || typeof text !== 'string') {
        return createResult(false, [], [], {}, 'No text to parse');
    }
    
    try {
        // Split into raw lines (preserve indentation for continuation detection)
        const rawLines = text.split('\n').filter(l => l.trim());
        const transactions = [];
        let currentTransaction = null;
        let currentSectionSign = null; // +1 (deposits), -1 (withdrawals), or null (mixed)
        
        for (const rawLine of rawLines) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            
            // Check for section header changes
            const sectionSign = detectSection(trimmed);
            if (sectionSign !== null) {
                // Flush current transaction before switching sections
                if (currentTransaction) {
                    transactions.push(currentTransaction);
                    currentTransaction = null;
                }
                currentSectionSign = sectionSign;
                continue;
            }
            
            // Skip end-of-table markers
            if (END_OF_TABLE_PATTERNS.some(p => p.test(trimmed))) {
                if (currentTransaction) {
                    transactions.push(currentTransaction);
                    currentTransaction = null;
                }
                continue;
            }
            
            // Try tab-separated parsing first
            let parsed = tryParseTabSeparated(trimmed);
            
            // Fall back to standard parsing
            if (!parsed) {
                parsed = tryParseTransaction(trimmed);
            }
            
            if (parsed) {
                // Apply section sign if known
                if (currentSectionSign !== null && parsed.amount !== 0) {
                    parsed.amount = Math.abs(parsed.amount) * currentSectionSign;
                }
                
                // Save previous transaction
                if (currentTransaction) {
                    transactions.push(currentTransaction);
                }
                currentTransaction = parsed;
            } else if (currentTransaction && isContinuationLine(rawLine, trimmed)) {
                // Append to description (continuation)
                currentTransaction.description += ' ' + trimmed;
            }
        }
        
        // Don't forget last transaction
        if (currentTransaction) {
            transactions.push(currentTransaction);
        }
        
        // Clean up descriptions
        const cleanedTransactions = transactions.map(t => ({
            ...t,
            description: cleanDescription(t.description)
        }));
        
        // Filter out likely non-transactions (very short descriptions, etc.)
        const filteredTransactions = cleanedTransactions.filter(t => 
            t.description.length > 2 || t.amount !== 0
        );
        
        const period = extractStatementPeriod(text);
        
        const metadata = {
            bank: 'unknown',
            statementType: 'generic',
            parserType: 'text-based',
            period,
            transactionCount: filteredTransactions.length,
            warning: 'This statement was parsed using text-based detection. Some transactions may be missing or incorrectly parsed.'
        };
        
        return createResult(
            filteredTransactions.length > 0, 
            filteredTransactions, 
            GENERIC_HEADERS, 
            metadata, 
            filteredTransactions.length === 0 ? 'No transactions could be extracted from this document' : null
        );
        
    } catch (error) {
        return createResult(false, [], [], {}, `Parsing error: ${error.message}`);
    }
}

/**
 * Parse using rectangle/position data with text-based fallback
 * 
 * Three-tier parsing strategy:
 * 1. Rectangle-based parsing (if PDF has lines/rectangles) - Most accurate
 * 2. Position-based parsing (word positions only) - Good accuracy
 * 3. Text-based parsing (plain text heuristics) - Fallback
 * 
 * @param {Array} pages - Pages data with word positions from extraction
 * @param {string} text - Extracted plain text (for fallback)
 * @param {Object} graphicElements - Optional object with rectangles, horizontal_lines, vertical_lines
 * @returns {Object} Parser result with transactions, headers, and metadata
 */
function parseWithPositions(pages, text, graphicElements = null) {
    let result = null;
    
    // Strategy 1: Try rectangle-based parsing if graphic elements are available
    let rectangleResult = null;
    if (graphicElements && (
        (graphicElements.rectangles && graphicElements.rectangles.length > 0) ||
        (graphicElements.horizontal_lines && graphicElements.horizontal_lines.length > 0) ||
        (graphicElements.vertical_lines && graphicElements.vertical_lines.length > 0)
    )) {
        rectangleResult = parseWithRectangles(
            pages,
            graphicElements.rectangles || [],
            graphicElements.horizontal_lines || [],
            graphicElements.vertical_lines || []
        );

        // If rectangle parsing succeeded with results, use it
        if (rectangleResult.success && rectangleResult.transactions.length > 0) {
            result = rectangleResult;
        }
    }

    // Strategy 2: Try position-based parsing (word positions + heuristics)
    // Also try if rectangle result exists but has low quality:
    //   - ALL generic COL_N headers (definite garbage)
    //   - Many generic COL_N headers (>30%)
    //   - Low preliminary confidence (< 0.7)
    //   - Very few transactions on a multi-page PDF (likely captured summary)
    // Position parser often does better than rectangle parser in these cases.
    let positionResult = null;
    const rectConf = result ? computeConfidence(result) : 0;
    const allGenericHeaders = result && result.headers &&
        result.headers.length > 0 &&
        result.headers.every(h => /^COL_\d+$/.test(h));
    const rectNeedsCheck = result && (
        allGenericHeaders ||
        rectConf < 0.7 ||
        (result.headers && result.headers.filter(h => /^COL_\d+$/.test(h)).length > result.headers.length * 0.2) ||
        (result.transactions.length < 5 && pages && pages.length > 1)
    );
    // If all headers are generic COL_N, discard rectangle result entirely
    if (allGenericHeaders) {
        result = null;
    }
    if ((!result || rectNeedsCheck) && pages && pages.length > 0) {
        positionResult = positionParse(pages);

        if (positionResult.success && positionResult.transactions.length > 0) {
            if (!result) {
                // No rectangle result — use position result directly
                result = positionResult;
            } else {
                // Both exist — compare quality and pick the better one
                const posConf = computeConfidence(positionResult);
                if (posConf > rectConf) {
                    result = positionResult;
                } else if (Math.abs(posConf - rectConf) < 0.1 &&
                           positionResult.transactions.length > result.transactions.length * 2) {
                    // Position parser found significantly more transactions at similar confidence
                    result = positionResult;
                }
            }
        }
    }
    
    // Strategy 3: Fall back to text-based parsing
    if (!result) {
        result = parse(text);
        
        // Add note about fallback attempts
        if (result.metadata) {
            result.metadata.fallbackUsed = true;
            const attempts = [];
            if (graphicElements) attempts.push('rectangle-based');
            if (pages && pages.length > 0) attempts.push('position-based');
            result.metadata.fallbackReason = `${attempts.join(' and ')} parsing found no transactions`;
        }
    }
    
    // ─── Post-processing: confidence scoring & validation ───────────
    // Enrich the result with quality assessment regardless of which parser was used.
    if (result && result.metadata) {
        result.metadata.confidence = computeConfidence(result);
        result.metadata.validationWarnings = validateTransactions(result);
    }
    
    return result;
}

export { parse, parseWithPositions };
