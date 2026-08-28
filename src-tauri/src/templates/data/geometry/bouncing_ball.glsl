void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float period = 0.72;
    float t = fract(iTime / period);
    float bounce = pow(abs(sin(3.14159265 * t)), 0.68);

    float cx = mod(iTime * 0.22 + 0.6, 2.6) - 1.3;

    float floorY = -0.34;
    float radius = 0.09;
    vec2 cpos = vec2(cx, floorY + radius + bounce * 0.62);
    vec2 rel = uv - cpos;
    float d = length(rel);

    vec3 col = mix(vec3(0.10, 0.12, 0.18), vec3(0.55, 0.62, 0.78), clamp(uv.y + 0.5, 0.0, 1.0));

    float floorLine = 1.0 - smoothstep(0.003, 0.009, abs(uv.y - floorY));
    col = mix(col, vec3(0.22, 0.26, 0.33), floorLine * 0.8);

    float shFade = 1.0 - bounce * 0.78;
    float shRadius = 0.07 + 0.10 * bounce;
    vec2 sv = (uv - vec2(cx, floorY)) * vec2(1.0, 3.5);
    float sd = length(sv);
    float shadow = (1.0 - smoothstep(shRadius * 0.35, shRadius, sd)) * shFade * 0.55;
    col = mix(col, vec3(0.05, 0.06, 0.09), shadow);

    if (d < radius)
    {
        vec2 n2 = rel / radius;
        float nz = sqrt(max(0.0, 1.0 - dot(n2, n2)));
        vec3 n = vec3(n2, nz);
        vec3 lightDir = normalize(vec3(-0.4, 0.65, 0.8));
        float diff = max(dot(n, lightDir), 0.0);
        vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
        float spec = pow(max(dot(n, halfVec), 0.0), 32.0);

        vec3 ball = vec3(0.82, 0.22, 0.18) * (0.22 + 0.85 * diff);
        ball += vec3(1.0, 0.95, 0.85) * spec * 0.9;

        float aa = 1.0 - smoothstep(radius - 0.003, radius, d);
        col = mix(col, ball, aa);
    }

    fragColor = vec4(col, 1.0);
}
