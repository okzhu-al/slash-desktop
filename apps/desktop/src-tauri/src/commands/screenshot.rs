use image::GenericImageView;
use screenshots::Screen;
use std::path::Path;
use tauri::Window;

/// Capture a screenshot of a specific region within the current window
/// and save it to the specified path.
///
/// Strategy: Capture the entire screen containing the window, then crop
/// to the specified region. This avoids coordinate system mismatches.
#[tauri::command]
pub async fn capture_element_screenshot(
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _device_pixel_ratio: f64,
    output_path: String,
) -> Result<(), String> {
    // Get the window inner position (content area position on screen)
    let window_position = window.inner_position().map_err(|e| e.to_string())?;
    let window_x = window_position.x as f64;
    let window_y = window_position.y as f64;

    // Calculate absolute screen coordinates (in logical pixels)
    let abs_x = window_x + x;
    let abs_y = window_y + y;

    log::info!(
        "[Screenshot] Window pos: ({}, {}), Element rel: ({}, {}), Abs: ({}, {}), Size: {}x{}",
        window_x, window_y, x, y, abs_x, abs_y, width, height
    );

    // Get primary screen
    let screens = Screen::all().map_err(|e| format!("Failed to get screens: {}", e))?;
    let primary_screen = screens
        .into_iter()
        .next()
        .ok_or_else(|| "No screen found".to_string())?;

    let display_info = primary_screen.display_info;
    log::info!(
        "[Screenshot] Screen: {}x{} at ({}, {}), scale: {}",
        display_info.width,
        display_info.height,
        display_info.x,
        display_info.y,
        display_info.scale_factor
    );

    // Capture the entire screen
    let full_screenshot = primary_screen
        .capture()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    log::info!(
        "[Screenshot] Full screenshot size: {}x{}",
        full_screenshot.width(),
        full_screenshot.height()
    );

    // Convert to DynamicImage for cropping
    let img = image::DynamicImage::ImageRgba8(full_screenshot);

    // Calculate crop coordinates in physical pixels
    // The screenshot is in physical pixels, so we need to account for scale factor
    let scale = display_info.scale_factor as f64;
    let crop_x = ((abs_x - display_info.x as f64) * scale) as u32;
    let crop_y = ((abs_y - display_info.y as f64) * scale) as u32;
    let crop_width = (width * scale) as u32;
    let crop_height = (height * scale) as u32;

    log::info!(
        "[Screenshot] Crop region: x={}, y={}, w={}, h={}",
        crop_x, crop_y, crop_width, crop_height
    );

    // Ensure crop region is within bounds
    let (img_width, img_height) = img.dimensions();
    let crop_x = crop_x.min(img_width.saturating_sub(1));
    let crop_y = crop_y.min(img_height.saturating_sub(1));
    let crop_width = crop_width.min(img_width.saturating_sub(crop_x));
    let crop_height = crop_height.min(img_height.saturating_sub(crop_y));

    if crop_width == 0 || crop_height == 0 {
        return Err(format!(
            "Invalid crop dimensions: {}x{} at ({}, {})",
            crop_width, crop_height, crop_x, crop_y
        ));
    }

    // Crop the image
    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    log::info!(
        "[Screenshot] Cropped size: {}x{}",
        cropped.width(),
        cropped.height()
    );

    // Save to file
    cropped
        .save(Path::new(&output_path))
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    log::info!("[Screenshot] Saved to: {}", output_path);

    Ok(())
}
