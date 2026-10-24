"""
PDF Text Extraction using pdfminer.six

This module provides layout-aware text extraction from PDF files.
Designed to run in Pyodide (WebAssembly) environment.

Enhanced with rectangle detection for improved table parsing.
"""

import io
from pdfminer.high_level import extract_text, extract_pages
from pdfminer.layout import LAParams, LTTextBox, LTTextLine, LTChar, LTAnno, LTRect, LTLine, LTCurve, LTFigure


# Layout parameters optimized for bank statements
# - line_margin: Margin between lines for grouping into text boxes
# - word_margin: Margin between words for spacing detection
# - char_margin: Margin between characters for word boundaries
# - boxes_flow: Controls the ordering of text boxes (None = natural reading order)
LAPARAMS = LAParams(
    line_margin=0.5,
    word_margin=0.1,
    char_margin=2.0,
    boxes_flow=0.5
)


def extract_text_from_bytes(pdf_bytes):
    """
    Extract text from PDF bytes with layout preservation.
    
    Args:
        pdf_bytes: bytes - Raw PDF file content
        
    Returns:
        dict with keys:
            - success: bool - Whether extraction succeeded
            - text: str - Extracted text (empty on failure)
            - error: str|None - Error message if failed
            - page_count: int - Number of pages processed
    """
    try:
        # Create in-memory file stream from bytes
        pdf_stream = io.BytesIO(pdf_bytes)
        
        # Extract text with layout awareness
        text = extract_text(pdf_stream, laparams=LAPARAMS)
        
        # Clean the extracted text
        cleaned_text = clean_text(text)
        
        # Count pages (approximate from page breaks in text)
        page_markers = cleaned_text.count('\f')  # Form feed indicates page break
        page_count = max(1, page_markers + 1)
        
        return {
            "success": True,
            "text": cleaned_text,
            "error": None,
            "page_count": page_count
        }
        
    except Exception as e:
        error_message = str(e)
        
        # Provide more specific error messages
        if "password" in error_message.lower():
            error_message = "PDF is password protected. Please provide an unprotected PDF."
        elif "decrypt" in error_message.lower():
            error_message = "PDF is encrypted. Please provide an unencrypted PDF."
        elif "invalid" in error_message.lower() or "corrupt" in error_message.lower():
            error_message = "PDF appears to be corrupted or invalid."
            
        return {
            "success": False,
            "text": "",
            "error": error_message,
            "page_count": 0
        }


def clean_text(text):
    """
    Clean and normalize extracted text.
    
    Args:
        text: str - Raw extracted text
        
    Returns:
        str - Cleaned text with normalized whitespace
    """
    if not text:
        return ""
    
    lines = []
    for line in text.split('\n'):
        # Remove control characters except newlines
        cleaned_line = ''.join(c for c in line if c == '\t' or c.isprintable())
        # Normalize internal whitespace but preserve structure
        cleaned_line = ' '.join(cleaned_line.split())
        if cleaned_line:
            lines.append(cleaned_line)
    
    return '\n'.join(lines)


def extract_words_from_line(line_obj):
    """
    Extract words with positions from a text line object.
    
    Args:
        line_obj: LTTextLine - Text line from PDFMiner
        
    Returns:
        list - List of word dictionaries with text, x, y, width, height, fontSize
    """
    words = []
    current_word = ""
    word_x0 = None
    word_y0 = None
    word_x1 = None
    word_y1 = None
    word_font_size = None
    
    for char in line_obj:
        if isinstance(char, LTChar):
            # Check if this is a space or continuation
            if current_word and word_x1 is not None:
                # If there's a gap, save current word and start new one
                gap = char.x0 - word_x1
                if gap > char.width * 0.3:  # Significant gap = new word
                    if current_word.strip():
                        words.append({
                            "text": current_word.strip(),
                            "x": round(word_x0, 2),
                            "y": round(word_y0, 2),
                            "width": round(word_x1 - word_x0, 2),
                            "height": round(word_y1 - word_y0, 2),
                            "fontSize": round(word_font_size, 2) if word_font_size else None
                        })
                    current_word = ""
                    word_x0 = None
                    word_font_size = None
            
            # Add character to current word
            if word_x0 is None:
                word_x0 = char.x0
                word_y0 = char.y0
                word_x1 = char.x1
                word_y1 = char.y1
                word_font_size = char.size if hasattr(char, 'size') else None
            else:
                word_x1 = char.x1
                word_y0 = min(word_y0, char.y0)
                word_y1 = max(word_y1, char.y1)
                # Track max font size in word (handles mixed sizes)
                if hasattr(char, 'size'):
                    if word_font_size is None:
                        word_font_size = char.size
                    else:
                        word_font_size = max(word_font_size, char.size)
            
            current_word += char.get_text()
            
        elif isinstance(char, LTAnno):
            # Annotation (usually space or newline)
            text = char.get_text()
            if text.isspace() and current_word.strip():
                # Save current word
                if word_x0 is not None:
                    words.append({
                        "text": current_word.strip(),
                        "x": round(word_x0, 2),
                        "y": round(word_y0, 2),
                        "width": round(word_x1 - word_x0, 2),
                        "height": round(word_y1 - word_y0, 2),
                        "fontSize": round(word_font_size, 2) if word_font_size else None
                    })
                current_word = ""
                word_x0 = None
                word_font_size = None
    
    # Don't forget the last word
    if current_word.strip() and word_x0 is not None:
        words.append({
            "text": current_word.strip(),
            "x": round(word_x0, 2),
            "y": round(word_y0, 2),
            "width": round(word_x1 - word_x0, 2),
            "height": round(word_y1 - word_y0, 2),
            "fontSize": round(word_font_size, 2) if word_font_size else None
        })
    
    return words


def extract_with_positions(pdf_bytes):
    """
    Extract text with word positions from PDF bytes.
    
    This is the main extraction function that provides both plain text
    and detailed position information for each word.
    
    Args:
        pdf_bytes: bytes - Raw PDF file content
        
    Returns:
        dict with keys:
            - success: bool - Whether extraction succeeded
            - text: str - Extracted plain text
            - pages: list - List of page objects with word positions
            - error: str|None - Error message if failed
            - page_count: int - Number of pages processed
    """
    try:
        pdf_stream = io.BytesIO(pdf_bytes)
        pages_data = []
        all_text_lines = []
        
        for page_num, page_layout in enumerate(extract_pages(pdf_stream, laparams=LAPARAMS)):
            page_words = []
            page_height = page_layout.height
            page_width = page_layout.width
            
            # Traverse the layout tree for text
            for element in page_layout:
                if isinstance(element, LTTextBox):
                    for line in element:
                        if isinstance(line, LTTextLine):
                            # Get line text for plain text output
                            line_text = line.get_text().strip()
                            if line_text:
                                all_text_lines.append(line_text)
                            
                            # Extract words with positions
                            words = extract_words_from_line(line)
                            for word in words:
                                # Convert y coordinate: PDF uses bottom-left origin,
                                # we convert to top-left origin for easier processing
                                word["y"] = round(page_height - word["y"] - word["height"], 2)
                                word["page"] = page_num + 1
                                page_words.append(word)
            
            pages_data.append({
                "pageNum": page_num + 1,
                "width": round(page_width, 2),
                "height": round(page_height, 2),
                "words": page_words
            })
        
        # Build plain text from collected lines
        plain_text = clean_text('\n'.join(all_text_lines))
        
        return {
            "success": True,
            "text": plain_text,
            "pages": pages_data,
            "error": None,
            "page_count": len(pages_data)
        }
        
    except Exception as e:
        error_message = str(e)
        
        # Provide more specific error messages
        if "password" in error_message.lower():
            error_message = "PDF is password protected. Please provide an unprotected PDF."
        elif "decrypt" in error_message.lower():
            error_message = "PDF is encrypted. Please provide an unencrypted PDF."
        elif "invalid" in error_message.lower() or "corrupt" in error_message.lower():
            error_message = "PDF appears to be corrupted or invalid."
        
        return {
            "success": False,
            "text": "",
            "pages": [],
            "error": error_message,
            "page_count": 0
        }


def extract_rectangles_and_lines(pdf_bytes):
    """
    Extract rectangle and line drawing elements from PDF for table boundary detection.
    
    This extracts visual elements like table borders, column separators, and row dividers
    which can significantly improve table structure detection.
    
    Args:
        pdf_bytes: bytes - Raw PDF file content
        
    Returns:
        dict with keys:
            - success: bool - Whether extraction succeeded
            - rectangles: list - List of rectangle objects with x, y, width, height
            - horizontal_lines: list - List of horizontal lines with x1, y1, x2, y2
            - vertical_lines: list - List of vertical lines with x1, y1, x2, y2
            - error: str|None - Error message if failed
    """
    try:
        pdf_stream = io.BytesIO(pdf_bytes)
        rectangles = []
        horizontal_lines = []
        vertical_lines = []
        
        for page_num, page_layout in enumerate(extract_pages(pdf_stream), start=1):
            page_height = page_layout.height
            
            # Recursively extract graphic elements from page
            for element in _extract_graphic_elements(page_layout, page_height, page_num):
                if element['type'] == 'rectangle':
                    rectangles.append(element)
                elif element['type'] == 'horizontal_line':
                    horizontal_lines.append(element)
                elif element['type'] == 'vertical_line':
                    vertical_lines.append(element)
        
        return {
            "success": True,
            "rectangles": rectangles,
            "horizontal_lines": horizontal_lines,
            "vertical_lines": vertical_lines,
            "error": None
        }
        
    except Exception as e:
        return {
            "success": False,
            "rectangles": [],
            "horizontal_lines": [],
            "vertical_lines": [],
            "error": str(e)
        }


def _extract_graphic_elements(layout_obj, page_height, page_num, elements=None):
    """
    Recursively extract graphic elements (rectangles, lines) from PDF layout.
    
    Args:
        layout_obj: PDFMiner layout object
        page_height: float - Page height for coordinate conversion
        page_num: int - Page number
        elements: list - Accumulator for found elements
        
    Returns:
        list - List of graphic element dictionaries
    """
    if elements is None:
        elements = []
    
    # Check if this object is a graphic element
    if isinstance(layout_obj, LTRect):
        # Rectangle (often used for table borders/cells)
        x = float(layout_obj.x0)
        y = float(page_height - layout_obj.y1)  # Convert to top-origin
        width = float(layout_obj.x1 - layout_obj.x0)
        height = float(layout_obj.y1 - layout_obj.y0)
        
        # Only include significant rectangles (filter out tiny decorative elements)
        if width > 5 and height > 3:
            elements.append({
                'type': 'rectangle',
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'page': page_num
            })
    
    elif isinstance(layout_obj, LTLine):
        # Line (often used for table borders, separators)
        x1 = float(layout_obj.x0)
        y1 = float(page_height - layout_obj.y0)  # Convert to top-origin
        x2 = float(layout_obj.x1)
        y2 = float(page_height - layout_obj.y1)
        
        # Determine if horizontal or vertical
        # Allow small tolerance (2 pixels) for near-horizontal/vertical lines
        is_horizontal = abs(y1 - y2) < 2
        is_vertical = abs(x1 - x2) < 2
        
        if is_horizontal and abs(x2 - x1) > 10:  # Significant horizontal line
            elements.append({
                'type': 'horizontal_line',
                'x1': min(x1, x2),
                'y': (y1 + y2) / 2,
                'x2': max(x1, x2),
                'length': abs(x2 - x1),
                'page': page_num
            })
        elif is_vertical and abs(y2 - y1) > 10:  # Significant vertical line
            elements.append({
                'type': 'vertical_line',
                'x': (x1 + x2) / 2,
                'y1': min(y1, y2),
                'y2': max(y1, y2),
                'length': abs(y2 - y1),
                'page': page_num
            })
    
    elif isinstance(layout_obj, LTCurve):
        # Some PDFs use curves for straight lines
        # Check if it's effectively a straight line
        x1 = float(layout_obj.x0)
        y1 = float(page_height - layout_obj.y0)
        x2 = float(layout_obj.x1)
        y2 = float(page_height - layout_obj.y1)
        
        is_horizontal = abs(y1 - y2) < 2
        is_vertical = abs(x1 - x2) < 2
        
        if is_horizontal and abs(x2 - x1) > 10:
            elements.append({
                'type': 'horizontal_line',
                'x1': min(x1, x2),
                'y': (y1 + y2) / 2,
                'x2': max(x1, x2),
                'length': abs(x2 - x1),
                'page': page_num
            })
        elif is_vertical and abs(y2 - y1) > 10:
            elements.append({
                'type': 'vertical_line',
                'x': (x1 + x2) / 2,
                'y1': min(y1, y2),
                'y2': max(y1, y2),
                'length': abs(y2 - y1),
                'page': page_num
            })
    
    # Recursively process child elements
    if hasattr(layout_obj, '__iter__'):
        try:
            for child in layout_obj:
                _extract_graphic_elements(child, page_height, page_num, elements)
        except TypeError:
            pass
    
    return elements
