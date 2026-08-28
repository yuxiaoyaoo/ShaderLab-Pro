vec3 sceneColor(vec2 uv)
{
    vec3 sky = mix(vec3(0.98, 0.72, 0.38), vec3(0.22, 0.24, 0.52), clamp(uv.y + 0.5, 0.0, 1.0));

    float sunD = length(uv - vec2(0.35, -0.05));
    sky += vec3(1.0, 0.80, 0.50) * (1.0 - smoothstep(0.0, 0.45, sunD)) * 0.9;

    for (int layer = 0; layer < 2; layer++)
    {
        float fl = float(layer);
        float ridgeY = -0.18 - 0.10 * fl
                     + 0.06 * sin(uv.x * (3.0 + fl * 2.0) + fl * 2.0)
                     + 0.03 * sin(uv.x * 7.3 - fl * 1.3);
        float below = 1.0 - smoothstep(ridgeY, ridgeY + 0.004, uv.y);
        vec3 hillC = mix(vec3(0.42, 0.26, 0.30), vec3(0.18, 0.12, 0.22), fl);
        sky = mix(sky, hillC, below);
    }
    return sky;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 col = sceneColor(uv);

    float r = length(uv) * 1.41421356;
    float vig = 1.0 - smoothstep(0.55, 1.30, r);

    vec3 processed = col * (0.28 + 0.72 * vig);
    processed = mix(processed, processed * processed, 0.25);

    col = mix(col, processed, step(0.0, uv.x));

    col += vec3(1.0) * (1.0 - smoothstep(0.000, 0.003, abs(uv.x))) * 0.35;

    fragColor = vec4(col, 1.0);
}
