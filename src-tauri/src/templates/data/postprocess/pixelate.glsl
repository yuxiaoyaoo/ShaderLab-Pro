void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float breathe = 0.5 + 0.5 * sin(iTime * 0.7);
    float cells = 26.0 * (0.78 + 0.50 * breathe);

    vec2 q = uv * cells;
    vec2 cellId = floor(q);
    vec2 cellUv = (cellId + 0.5) / cells;

    vec3 col = mix(vec3(0.10, 0.12, 0.20), vec3(0.45, 0.50, 0.65), clamp(cellUv.y + 0.5, 0.0, 1.0));

    float groundY = -0.25;
    float isGround = 1.0 - smoothstep(groundY, groundY + 0.012, cellUv.y);
    col = mix(col, vec3(0.18, 0.16, 0.22), isGround * 0.9);

    float bt = fract(iTime * 0.62);
    vec2 ballPos = vec2(sin(iTime * 0.8) * 0.45,
                        groundY + 0.12 + pow(abs(sin(3.14159265 * bt)), 0.72) * 0.52);
    float bd = length(cellUv - ballPos);
    float isBall = 1.0 - smoothstep(0.115, 0.135, bd);
    col = mix(col, vec3(0.95, 0.35, 0.20), isBall);

    float hiLen = length(cellUv - (ballPos + vec2(-0.035, 0.035)));
    col += vec3(1.0, 0.9, 0.8) * (1.0 - smoothstep(0.015, 0.05, hiLen)) * isBall * 0.7;

    vec2 f = fract(q) - 0.5;
    float frameBand = step(0.44, max(abs(f.x), abs(f.y)));
    col *= 1.0 - frameBand * 0.40;

    fragColor = vec4(col, 1.0);
}
